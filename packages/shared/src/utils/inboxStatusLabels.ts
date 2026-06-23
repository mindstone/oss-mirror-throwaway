import type { InboxConfidence, InboxItem } from '../types/inbox';

export type PriorityLevel = 'urgent' | 'high' | 'medium' | 'low';

type DerivePriorityInput = Pick<
  InboxItem,
  'urgent' | 'important' | 'dueBy' | 'category' | 'draft' | 'actions' | 'clarifyingQuestion'
>;

/**
 * Derive a display priority from item signals.
 *
 * Priority is determined in two tiers:
 *
 * 1. Explicit user overrides — when important is explicitly false (differs from
 *    the default of true), the user has made a deliberate priority choice via the
 *    dropdown. This takes precedence over content-signal derivation.
 *
 * 2. Content-signal derivation — for items where the user hasn't overridden:
 *    Urgent — urgent boolean set
 *    High — Rebel has something ready or there's external time pressure
 *    Medium — needs user attention but not as ready
 *    Low — informational or not deemed important by the system
 */
export function derivePriorityLevel(item: DerivePriorityInput): PriorityLevel {
  // Tier 1: Explicit user overrides (important=false is a deliberate non-default choice)
  if (item.urgent && item.important === false) return 'medium';
  if (!item.urgent && item.important === false) return 'low';

  // Tier 2: Content-signal derivation
  if (item.urgent) return 'urgent';
  if (typeof item.dueBy === 'number' && item.dueBy <= Date.now()) return 'high';
  if (item.category === 'user-request') return 'high';
  if (item.draft?.trim()) return 'high';
  if (item.actions?.length) return 'high';

  if (item.important) return 'medium';
  if (item.clarifyingQuestion?.trim()) return 'medium';
  if (item.category === 'meeting-action' || item.category === 'follow-up') return 'medium';
  if (typeof item.dueBy === 'number') return 'medium';

  if (item.category === 'system' || item.category === 'uncategorized') return 'low';

  return 'medium';
}

export function getPriorityLabel(level: PriorityLevel): string {
  switch (level) {
    case 'urgent': return 'Urgent';
    case 'high': return 'High priority';
    case 'medium': return 'Medium priority';
    case 'low': return 'Low priority';
  }
}

const CYCLE_ORDER: PriorityLevel[] = ['urgent', 'high', 'medium', 'low'];

export function cyclePriority(current: PriorityLevel): PriorityLevel {
  return CYCLE_ORDER[(CYCLE_ORDER.indexOf(current) + 1) % CYCLE_ORDER.length];
}

export function priorityToQuadrant(level: PriorityLevel): { urgent: boolean; important: boolean } {
  switch (level) {
    case 'urgent': return { urgent: true, important: true };
    case 'high': return { urgent: false, important: true };
    case 'medium': return { urgent: true, important: false };
    case 'low': return { urgent: false, important: false };
  }
}

export function isPriorityPinnedToToday(item: DerivePriorityInput): boolean {
  return item.urgent === true && item.important !== false;
}

export const PRIORITY_SORT_RANK: Record<PriorityLevel, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** @deprecated Use derivePriorityLevel + getPriorityLabel instead */
export function getStatusLabel(confidence: InboxConfidence | undefined, _addedAt?: number): string {
  switch (confidence) {
    case 'high': return 'High priority';
    case 'medium': return 'Medium priority';
    case 'low': return 'Low priority';
    default: return 'Medium priority';
  }
}
