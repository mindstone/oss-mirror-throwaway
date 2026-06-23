// Unused fields retained for backwards compatibility — consumers may construct
// typed object literals against this exported interface, and narrowing it would
// cause excess-property TS errors at call sites.
export interface ResolveInboxCtaLabelItem {
  draft?: string | null;
  clarifyingQuestion?: string | null;
  source?: {
    kind?: string;
    label?: string;
  } | null;
  references?: Array<{ kind: string }>;
  actions?: Array<{ type: string; platforms?: string[] }>;
  category?: string;
  actionLabel?: string;
  title?: string | null;
}

/**
 * Resolve the primary action CTA for an Actions item.
 * Product contract: the Actions surface starts a Rebel review/prep loop; it does
 * not expose task-specific verbs like Send, Investigate, Open, or Approve.
 */
export function resolveInboxCtaLabel(_item: ResolveInboxCtaLabelItem): string {
  return 'Review';
}
