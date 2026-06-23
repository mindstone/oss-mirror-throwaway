/**
 * approvalFacetAnalysis
 *
 * Computes approval analytics facet signals from decision-signal **data
 * availability** at render time. A card is "thin" when none of those signals
 * are available.
 *
 * This is what the R17 "Help me decide" gate reads to decide whether Phase 1's
 * facet-surfacing reached the low-info subset.
 *
 * Semantics note (2026-05-31, approval-card compact redesign Stage 5):
 * these facets no longer describe specific inline preview/withheld UI elements
 * on the card. They intentionally describe whether the underlying signal data
 * exists for that approval.
 *
 * Definition (per plan):
 *   thinFacets = !hasContentPreview
 *     && !hasWithheldPreview
 *     && reasonLength < 40
 *     && !hasWhyFacets
 *
 * Phase 1 has no structured facet list yet (R4 is Phase 2), so
 * `hasWhyFacets` is always false today. Included in the shape so Phase 2
 * can set it without a signature change.
 *
 * See docs/plans/260419_approval_card_clarity_improvements.md § Analytics
 * Instrumentation, and the tutorial at
 * docs/tutorials/260420b_approval_card_clarity_plan.html § 5.
 */

export type ApprovalFacetSignals = {
  hasContentPreview: boolean;
  hasWithheldPreview: boolean;
  hasWhyFacets: boolean;
  reasonLength: number;
  thinFacets: boolean;
};

/**
 * Exported so ANALYTICS_DATA_DICTIONARY.md and the R17 promotion-gate
 * computation can reference the same numeric boundary as the runtime code.
 * Shifting this value invalidates prior baseline `thinFacets` tagging — treat
 * it as a versioned constant.
 */
export const THIN_REASON_CHAR_THRESHOLD = 40;

function normalizeToString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function computeApprovalFacets(params: {
  /** Raw content-preview string (memory approvals). */
  contentPreview?: string;
  /** Raw summary string (staged-file / memory approvals). */
  summary?: string;
  /**
   * Human-readable explanatory text available on the current surface (for
   * example visible safety-reason copy). This stays intentionally surface-local
   * while the facet booleans remain data-availability signals.
   */
  whyText?: string;
  /**
   * Data-availability flag for withheld-preview state. This can be true even
   * when the card does not render an inline withheld line.
   */
  isPreviewWithheld?: boolean;
  hasStructuredFacets?: boolean;
}): ApprovalFacetSignals {
  const hasContentPreview = Boolean(
    normalizeToString(params.contentPreview).trim().length > 0
    || normalizeToString(params.summary).trim().length > 0
  );
  const hasWithheldPreview = Boolean(params.isPreviewWithheld);
  const hasWhyFacets = Boolean(params.hasStructuredFacets);
  const reasonLength = normalizeToString(params.whyText).trim().length;
  const thinFacets = !hasContentPreview
    && !hasWithheldPreview
    && reasonLength < THIN_REASON_CHAR_THRESHOLD
    && !hasWhyFacets;
  return { hasContentPreview, hasWithheldPreview, hasWhyFacets, reasonLength, thinFacets };
}

/**
 * Narrow a raw `sharing` string (which may be `undefined`, `null`, an empty
 * string, or an off-spec value like `'shared'`) to the closed analytics enum.
 * Empty strings / unknown values are normalised to `'unclear'` rather than
 * silently dropped, so upstream data-quality problems are visible in the
 * event stream instead of disappearing.
 */
export function narrowSharing(
  raw: string | null | undefined,
): 'private' | 'restricted' | 'company-wide' | 'public' | 'unclear' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'private' || raw === 'restricted' || raw === 'company-wide' || raw === 'public') {
    return raw;
  }
  return 'unclear';
}
