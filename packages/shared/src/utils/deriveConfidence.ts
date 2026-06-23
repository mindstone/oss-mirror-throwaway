import type { InboxItem, InboxConfidence } from '../types/inbox';

type DeriveConfidenceInput = Pick<
  InboxItem,
  'confidence' | 'draft' | 'clarifyingQuestion' | 'actions' | 'references' | 'category'
>;

/**
 * Derive a confidence level for an inbox item based on its content signals.
 *
 * Priority chain (first match wins):
 * 1. Explicit `confidence` on the item (automation/agent override)
 * 2. Draft present → high (deliverable ready for approval)
 * 3. Clarifying question → medium (needs user input)
 * 4. Concrete actions → high (actionable)
 * 5. Email reference → high (reply-ready)
 * 6. Category-based heuristic
 * 7. Default → medium
 */
export function deriveConfidence(item: DeriveConfidenceInput): InboxConfidence {
  if (item.confidence) return item.confidence;
  if (item.draft?.trim()) return 'high';
  if (item.clarifyingQuestion?.trim()) return 'medium';
  if (item.actions?.length) return 'high';
  if (item.references?.some(r => r.kind === 'email')) return 'high';
  if (item.category === 'automation' || item.category === 'user-request') return 'high';
  if (item.category === 'meeting-action' || item.category === 'follow-up') return 'medium';
  if (item.category === 'system' || item.category === 'uncategorized') return 'low';
  return 'medium';
}
