import { describe, it, expect } from 'vitest';
import {
  mapContributionToCardState,
  createGitHubCheckState,
  SUBMITTED_HELPER_TEXT,
  type ContributionStatus,
  type ContributionRecord,
  type MappedBuildCardState,
  type MCPBuildTool,
  type SubmittedSubstatus,
} from '../utils/contributionStateMapping';

/** All valid ContributionStatus values. */
const ALL_CONTRIBUTION_STATUSES: readonly ContributionStatus[] = [
  'draft', 'testing', 'ready_to_submit', 'submitted',
  'ci_pass', 'ci_fail', 'changes_requested',
  'approved', 'rejected', 'published',
] as const;

// ─── Helpers ────────────────────────────────────────────────────────

function makeContribution(overrides: Partial<ContributionRecord> = {}): ContributionRecord {
  return {
    connectorName: 'TestConnector',
    status: 'draft',
    ...overrides,
  };
}

const SAMPLE_TOOLS: MCPBuildTool[] = [
  { name: 'list_items', status: 'pass' },
  { name: 'create_item', status: 'pass' },
];

const FAILING_TOOLS: MCPBuildTool[] = [
  { name: 'list_items', status: 'pass' },
  { name: 'create_item', status: 'fail', error: 'auth failed' },
];

// ─── VAL-CARD-002: All 12 states map correctly ─────────────────────

describe('contributionStateMapping', () => {
  describe('mapContributionToCardState', () => {
    it('returns null for null/undefined contribution (VAL-CARD-006)', () => {
      expect(mapContributionToCardState(null)).toBeNull();
      expect(mapContributionToCardState(undefined)).toBeNull();
    });

    // Row 1: draft → building.implementing (Phase 4 just finished).
    // Previously `draft` mapped to `submit-prompt`, which caused the
    // "Add to the community" card to appear before testing had run.
    // See docs/plans/260420_simplify_mcp_build_flow.md (superseded entry).
    it('maps draft to building phase with implementing subphase', () => {
      const contribution = makeContribution({ status: 'draft' });
      const result = mapContributionToCardState(contribution, { tools: SAMPLE_TOOLS });
      expect(result).toEqual({
        phase: 'building',
        subphase: 'implementing',
        connectorName: 'TestConnector',
        tools: SAMPLE_TOOLS,
      });
    });

    // Row 2: testing (no errors) → building.testing. Previously this was
    // invisible (null), but we now show a neutral "Testing <name>" card
    // so the user has visible reassurance during the long Phase 6 loop.
    // Testing-WITH-errors remains the testing-error phase (see Row 3).
    it('maps testing without errors to building phase with testing subphase', () => {
      const contribution = makeContribution({ status: 'testing' });
      const result = mapContributionToCardState(contribution, { tools: SAMPLE_TOOLS });
      expect(result).toEqual({
        phase: 'building',
        subphase: 'testing',
        connectorName: 'TestConnector',
        tools: SAMPLE_TOOLS,
      });
    });

    // Row 3: testing + errors → testing-error
    it('maps testing with errors to testing-error phase', () => {
      const contribution = makeContribution({ status: 'testing' });
      const result = mapContributionToCardState(contribution, {
        tools: FAILING_TOOLS,
        hasTestErrors: true,
        autoFixMessage: 'Fixing auth...',
      });
      expect(result).toEqual({
        phase: 'testing-error',
        connectorName: 'TestConnector',
        tools: FAILING_TOOLS,
        autoFixMessage: 'Fixing auth...',
      });
    });

    // Row 4: ready_to_submit → submit-prompt
    it('maps ready_to_submit to submit-prompt phase', () => {
      const contribution = makeContribution({ status: 'ready_to_submit' });
      const result = mapContributionToCardState(contribution, { tools: SAMPLE_TOOLS });
      expect(result).toEqual({
        phase: 'submit-prompt',
        connectorName: 'TestConnector',
        tools: SAMPLE_TOOLS,
      });
    });

    // Row 5: github-check (transient, not persisted)
    it('createGitHubCheckState creates github-check phase', () => {
      const result = createGitHubCheckState('TestConnector');
      expect(result).toEqual({
        phase: 'github-check',
        connectorName: 'TestConnector',
      });
    });

    // Row 6: submitted → submitted (under_review)
    it('maps submitted to submitted phase with under_review substatus', () => {
      const contribution = makeContribution({ status: 'submitted' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.under_review,
        substatus: 'under_review',
      });
    });

    // Row 7: ci_pass → submitted (pending_approval)
    it('maps ci_pass to submitted phase with pending_approval substatus', () => {
      const contribution = makeContribution({ status: 'ci_pass' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.pending_approval,
        substatus: 'pending_approval',
      });
    });

    // Row 8: ci_fail → submitted (checks_failed)
    it('maps ci_fail to submitted phase with checks_failed substatus', () => {
      const contribution = makeContribution({ status: 'ci_fail' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.checks_failed,
        substatus: 'checks_failed',
      });
    });

    // Row 9: changes_requested → submitted (changes_needed)
    it('maps changes_requested to submitted phase with changes_needed substatus', () => {
      const contribution = makeContribution({ status: 'changes_requested' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.changes_needed,
        substatus: 'changes_needed',
      });
    });

    // Row 10: approved → submitted (approved)
    it('maps approved to submitted phase with approved substatus', () => {
      const contribution = makeContribution({ status: 'approved' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.approved,
        substatus: 'approved',
      });
    });

    // Row 11: rejected → submitted (rejected)
    it('maps rejected to submitted phase with rejected substatus', () => {
      const contribution = makeContribution({ status: 'rejected' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.rejected,
        substatus: 'rejected',
      });
    });

    // Row 12: published → submitted (published)
    it('maps published to submitted phase with published substatus', () => {
      const contribution = makeContribution({ status: 'published' });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.published,
        substatus: 'published',
      });
    });

    // VAL-CARD-002: Parameterized coverage of ALL status values. Every
    // status now produces a visible card:
    //  - draft    → building.implementing
    //  - testing  → building.testing (no errors) or testing-error
    //  - ready_to_submit → submit-prompt
    //  - submitted..published → submitted substatuses
    it.each(ALL_CONTRIBUTION_STATUSES)(
      'maps %s to a non-null card state',
      (status: ContributionStatus) => {
        const contribution = makeContribution({ status });
        const result = mapContributionToCardState(contribution, {
          tools: SAMPLE_TOOLS,
        });
        expect(result).not.toBeNull();
        expect(result!.connectorName).toBe('TestConnector');
      },
    );

    it('returns building.testing for testing status without errors (neutral progress card)', () => {
      const contribution = makeContribution({ status: 'testing' });
      const result = mapContributionToCardState(contribution, {
        tools: SAMPLE_TOOLS,
      });
      expect(result).toEqual({
        phase: 'building',
        subphase: 'testing',
        connectorName: 'TestConnector',
        tools: SAMPLE_TOOLS,
      });
    });
  });

  // ─── VAL-CARD-004: Helper text varies by substatus ──────────────

  describe('SUBMITTED_HELPER_TEXT', () => {
    const expectedSubstatuses: SubmittedSubstatus[] = [
      'under_review',
      'pending_approval',
      'checks_failed',
      'changes_needed',
      'approved',
      'rejected',
      'published',
    ];

    it('has unique helper text for each substatus', () => {
      const texts = expectedSubstatuses.map((s) => SUBMITTED_HELPER_TEXT[s]);
      const unique = new Set(texts);
      expect(unique.size).toBe(expectedSubstatuses.length);
    });

    it.each(expectedSubstatuses)(
      'produces distinct helper text for submitted substatus "%s"',
      (substatus) => {
        expect(SUBMITTED_HELPER_TEXT[substatus]).toBeTruthy();
        expect(typeof SUBMITTED_HELPER_TEXT[substatus]).toBe('string');
        expect(SUBMITTED_HELPER_TEXT[substatus].length).toBeGreaterThan(0);
      },
    );
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('testing-error omits autoFixMessage when not provided', () => {
      const contribution = makeContribution({ status: 'testing' });
      const result = mapContributionToCardState(contribution, {
        tools: FAILING_TOOLS,
        hasTestErrors: true,
      });
      expect(result).toEqual({
        phase: 'testing-error',
        connectorName: 'TestConnector',
        tools: FAILING_TOOLS,
      });
    });

    it('rejected status appends reviewNotes from contribution to helper text', () => {
      const contribution = makeContribution({
        status: 'rejected',
        reviewNotes: 'Missing LICENSE file.',
      });
      const result = mapContributionToCardState(contribution) as MappedBuildCardState & {
        phase: 'submitted';
        helperText: string;
      };
      expect(result.helperText).toContain("They didn't take this one.");
      expect(result.helperText).toContain('Missing LICENSE file.');
    });

    it('rejected status appends options.reviewNotes when provided', () => {
      const contribution = makeContribution({ status: 'rejected' });
      const result = mapContributionToCardState(contribution, {
        reviewNotes: 'Review notes override.',
      }) as MappedBuildCardState & { phase: 'submitted'; helperText: string };
      expect(result.helperText).toContain('Review notes override.');
    });

    it('uses connectorName from contribution record', () => {
      const contribution = makeContribution({ connectorName: 'my-zendesk-connector' });
      const result = mapContributionToCardState(contribution);
      expect(result!.connectorName).toBe('my-zendesk-connector');
    });

    it('passes attributionName through for submitted contributions', () => {
      const contribution = makeContribution({
        status: 'ci_pass',
        attributionName: 'octocat',
      });
      const result = mapContributionToCardState(contribution);
      expect(result).toEqual({
        phase: 'submitted',
        connectorName: 'TestConnector',
        helperText: SUBMITTED_HELPER_TEXT.pending_approval,
        substatus: 'pending_approval',
        authorName: 'octocat',
      });
    });
  });

  // ─── Stage 3: testing-error surfaces lastTransitionError ─────────

  describe('mapContributionToCardState — testing-error lastTransitionError (Stage 3)', () => {
    it('omits lastTransitionError on testing-error card when absent on record', () => {
      const result = mapContributionToCardState(
        makeContribution({ status: 'testing' }),
        { hasTestErrors: true, tools: FAILING_TOOLS },
      );
      expect(result).toEqual({
        phase: 'testing-error',
        connectorName: 'TestConnector',
        tools: FAILING_TOOLS,
      });
    });

    it('attaches raw lastTransitionError to testing-error card when present on record', () => {
      const raw = "Invalid transition: testing \u2192 ready_to_submit.";
      const result = mapContributionToCardState(
        makeContribution({ status: 'testing', lastTransitionError: raw }),
        { hasTestErrors: true, tools: FAILING_TOOLS },
      );
      expect(result).toMatchObject({
        phase: 'testing-error',
        connectorName: 'TestConnector',
        tools: FAILING_TOOLS,
        lastTransitionError: raw,
      });
    });

    it('shows testing-error when status is testing and lastTransitionError exists even without hasTestErrors', () => {
      const raw = '{"reason":"non-canonical-path","observedPath":"/tmp/mcp-servers/foo"}';
      const result = mapContributionToCardState(
        makeContribution({ status: 'testing', lastTransitionError: raw }),
        { tools: SAMPLE_TOOLS, hasTestErrors: false },
      );
      expect(result).toEqual({
        phase: 'testing-error',
        connectorName: 'TestConnector',
        tools: SAMPLE_TOOLS,
        lastTransitionError: raw,
      });
    });
  });

  // ─── Stage 4 — v4 field invariance (260426 foolproof flow) ─────────
  //
  // Extra v4 fields landed by Stage 2 + Stage 3 (canonicalConnectorPath,
  // linkedSessionIds, readiness timestamps, lastBuildFingerprint) MUST NOT
  // change the mapper output for the same logical status. Pin this contract
  // so future schema growth in the contribution record can't silently shift
  // renderer behavior. Hidden gotcha #8: the mirrored `ContributionRecord`
  // doesn't declare these v4 fields; we widen via the typed-alias spread
  // pattern so structural typing accepts the test inputs.
  //
  // See docs/plans/260426_foolproof_contribution_flow_stage4.md.
  describe('Stage 4 — v4 field invariance', () => {
    /**
     * Synthetic v4 fields landed by Stage 2 + Stage 3. Treated as opaque
     * values from the mapper's perspective; the assertion is that adding
     * any/all of them produces the SAME `MappedBuildCardState` as the
     * pre-v4 baseline.
     */
    const V4_OVERLAY = {
      canonicalConnectorPath: '/Users/example/mcp-servers/foo-mcp',
      linkedSessionIds: ['session-a', 'session-b', 'session-c'],
      lastBuildDetectedAt: '2026-04-26T10:00:00Z',
      lastTestPassedAt: '2026-04-26T10:05:00Z',
      lastRegisteredAt: '2026-04-26T10:06:00Z',
      lastReadyRequestedAt: '2026-04-26T10:07:00Z',
      lastBuildFingerprint: 'sha256-cafe',
    } as const;

    type V4Augmented = ContributionRecord & typeof V4_OVERLAY;

    it('draft → building.implementing is invariant under v4 fields', () => {
      const v3 = makeContribution({ status: 'draft' });
      const v4: V4Augmented = { ...v3, ...V4_OVERLAY };
      expect(mapContributionToCardState(v4, { tools: SAMPLE_TOOLS })).toEqual(
        mapContributionToCardState(v3, { tools: SAMPLE_TOOLS }),
      );
    });

    it('testing → building.testing is invariant under v4 fields', () => {
      const v3 = makeContribution({ status: 'testing' });
      const v4: V4Augmented = { ...v3, ...V4_OVERLAY };
      expect(mapContributionToCardState(v4, { tools: SAMPLE_TOOLS })).toEqual(
        mapContributionToCardState(v3, { tools: SAMPLE_TOOLS }),
      );
    });

    it('ready_to_submit → submit-prompt is invariant under v4 fields', () => {
      const v3 = makeContribution({ status: 'ready_to_submit' });
      const v4: V4Augmented = { ...v3, ...V4_OVERLAY };
      expect(mapContributionToCardState(v4, { tools: SAMPLE_TOOLS })).toEqual(
        mapContributionToCardState(v3, { tools: SAMPLE_TOOLS }),
      );
    });

    it('submitted → submitted is invariant under v4 fields', () => {
      const v3 = makeContribution({
        status: 'submitted',
        prUrl: 'https://github.com/x/y/pull/1',
      });
      const v4: V4Augmented = { ...v3, ...V4_OVERLAY };
      expect(mapContributionToCardState(v4)).toEqual(mapContributionToCardState(v3));
    });
  });
});
