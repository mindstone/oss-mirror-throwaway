import { describe, it, expect } from 'vitest';
import { computeApprovalFacets, narrowSharing } from '../approvalFacetAnalysis';

describe('computeApprovalFacets', () => {
  it('flags a card as thin when it has no preview and only a short reason', () => {
    const result = computeApprovalFacets({
      whyText: 'Too risky',
      hasStructuredFacets: false,
    });

    expect(result).toEqual({
      hasContentPreview: false,
      hasWithheldPreview: false,
      hasWhyFacets: false,
      reasonLength: 9,
      thinFacets: true,
    });
  });

  it('does not flag thin when a content preview is present', () => {
    const result = computeApprovalFacets({
      contentPreview: 'Here is a preview of the memory content',
      whyText: '',
    });
    expect(result.hasContentPreview).toBe(true);
    expect(result.thinFacets).toBe(false);
  });

  it('flags hasWithheldPreview when isPreviewWithheld is passed and contentPreview is undefined', () => {
    const result = computeApprovalFacets({
      isPreviewWithheld: true,
      contentPreview: undefined,
      whyText: '',
    });

    // Withheld state is informative in analytics on its own (data-availability
    // semantics), so the card must not count as thin even when the why text is
    // short or empty.
    expect(result.hasContentPreview).toBe(false);
    expect(result.hasWithheldPreview).toBe(true);
    expect(result.thinFacets).toBe(false);
  });

  it('does not suppress hasWithheldPreview when contentPreview is also provided (pass-through semantics)', () => {
    const result = computeApprovalFacets({
      isPreviewWithheld: true,
      contentPreview: 'actual text',
    });

    // Caller-contract violation case: expose both flags rather than silently
    // dropping one. Callers are responsible for passing true only when the
    // underlying approval data indicates a withheld-preview state.
    expect(result.hasContentPreview).toBe(true);
    expect(result.hasWithheldPreview).toBe(true);
  });

  it('does not flag thin when a summary is present (staged-file path)', () => {
    const result = computeApprovalFacets({
      summary: 'Claim: contracts renew Jan 1. Source: meeting-notes.md',
    });
    expect(result.hasContentPreview).toBe(true);
    expect(result.thinFacets).toBe(false);
  });

  it('flags hasWithheldPreview with summary present (memory-card-with-summary case)', () => {
    const result = computeApprovalFacets({
      isPreviewWithheld: true,
      summary: 'Credential: token saved',
      contentPreview: undefined,
    });

    // Memory cards can carry a metadata summary while withholding their actual
    // content preview; analytics data-availability semantics preserve both
    // signals.
    expect(result.hasContentPreview).toBe(true);
    expect(result.hasWithheldPreview).toBe(true);
    expect(result.thinFacets).toBe(false);
  });

  it('does not flag thin when structured facets are present', () => {
    const result = computeApprovalFacets({
      whyText: 'short',
      hasStructuredFacets: true,
    });
    expect(result.hasWhyFacets).toBe(true);
    expect(result.thinFacets).toBe(false);
  });

  it('does not flag thin when the reason is long enough', () => {
    const reason = 'This file contains a credential that may be leaked to the broader team';
    const result = computeApprovalFacets({ whyText: reason });
    expect(result.reasonLength).toBe(reason.length);
    expect(result.thinFacets).toBe(false);
  });

  it('handles missing fields as empty strings', () => {
    const result = computeApprovalFacets({});
    expect(result).toEqual({
      hasContentPreview: false,
      hasWithheldPreview: false,
      hasWhyFacets: false,
      reasonLength: 0,
      thinFacets: true,
    });
  });

  it('treats whitespace-only preview / summary as missing', () => {
    const result = computeApprovalFacets({
      contentPreview: '   ',
      summary: '\n',
      whyText: 'hm',
    });
    expect(result.hasContentPreview).toBe(false);
    expect(result.thinFacets).toBe(true);
  });

  it('normalises non-string whyText to empty instead of throwing', () => {
    // Defensive: future loosened types could pass a non-string through; the
    // facet computation must tolerate it rather than crash rendering.
    const result = computeApprovalFacets({
      whyText: undefined as unknown as string,
    });
    expect(result.reasonLength).toBe(0);
    expect(result.thinFacets).toBe(true);
  });
});

describe('narrowSharing', () => {
  it('passes through each valid enum value unchanged', () => {
    expect(narrowSharing('private')).toBe('private');
    expect(narrowSharing('restricted')).toBe('restricted');
    expect(narrowSharing('company-wide')).toBe('company-wide');
    expect(narrowSharing('public')).toBe('public');
  });

  it('returns undefined only for null / undefined', () => {
    expect(narrowSharing(null)).toBeUndefined();
    expect(narrowSharing(undefined)).toBeUndefined();
  });

  it('maps empty string and unknown non-enum strings to unclear', () => {
    // Empty string is a common upstream data-quality failure mode; we want
    // it visible in the event stream as `unclear`, not silently dropped.
    expect(narrowSharing('')).toBe('unclear');
    expect(narrowSharing('shared')).toBe('unclear');
    expect(narrowSharing('TEAM')).toBe('unclear');
  });
});

// Cross-surface parity contract — see heavy-review Finding #2 in
// docs/plans/260419_approval_card_clarity_improvements.md § Gate 2 Heavy review.
// DrawerApprovalCard and StagedFileCard both render staged-file approvals,
// and must agree on the `cardViewed` payload for a given approvalId —
// otherwise first-mount-wins on the shared tally key makes the same card
// flip between `thinFacets: true` and `thinFacets: false` depending on
// which surface the user happened to view first. The fix was to share
// `getStagedFileWhyText` between the two surfaces; this test locks in
// that invariant so a future regression (e.g. someone re-inlining the
// helper into just one surface) trips a red test rather than silently
// skewing the R17 promotion-gate subset.
describe('cross-surface parity — staged-file analytics input', () => {
  // We exercise computeApprovalFacets with both (whyText present) and
  // (whyText absent) paths — every blockedBy value that
  // `getStagedFileWhyText` recognises plus the "fall through" path where
  // sharing alone drives the message.
  const baseFile = {
    id: 'staged-parity',
    realPath: '/Users/x/General/note.md',
    spaceName: 'General',
    spacePath: 'General/note.md',
    sessionId: 'session-parity',
    baseHash: 'new-file',
    summary: 'Some meaningful summary content',
    stagedAt: Date.UTC(2026, 3, 22),
    sensitivity: 'high' as const,
    fileName: 'note.md',
    sessionTitle: null,
  };

  // Import helpers lazily so the facets test file stays dependency-light.
  it.each([
    ['safety_prompt', undefined],
    ['sensitivity_eval', undefined],
    ['structural_policy', undefined],
    ['eval_error', undefined],
    [undefined, 'company-wide'],
  ] as const)(
    'produces identical facet signals for blockedBy=%s / sharing=%s on both surfaces',
    async (blockedBy, sharing) => {
      const { getStagedFileWhyText } = await import('../approvalWhyText');
      const file = { ...baseFile, blockedBy, sharing };

      // Cast to `never` at the function boundary only — getStagedFileWhyText
      // accepts a narrower StagedFileItem union; we exercise parity across
      // off-spec blockedBy / sharing values deliberately.
      const drawerWhy = getStagedFileWhyText(file as never);
      const stripWhy = getStagedFileWhyText(file as never);
      expect(drawerWhy).toBe(stripWhy);

      const drawerFacets = computeApprovalFacets({
        summary: file.summary,
        whyText: drawerWhy,
        hasStructuredFacets: false,
      });
      const stripFacets = computeApprovalFacets({
        summary: file.summary,
        whyText: stripWhy,
        hasStructuredFacets: false,
      });
      expect(drawerFacets).toEqual(stripFacets);
    },
  );
});
