/**
 * Tests for contribution section eligibility gating.
 *
 * Pure helper function tests that verify:
 * - shouldShowContributionSection: contribution record + connected state
 * - shouldShowShareCta: draft/ready_to_submit status gating
 *
 * @see docs/plans/260414_p8_contribution_status_settings_card.md
 */
import { describe, it, expect } from 'vitest';
import {
  shouldShowContributionSection,
  shouldShowShareCta,
  isStuckTestingContribution,
} from '../components/ConnectorContributionSection';
import type { ConnectorContribution } from '../hooks/useConnectorContribution';

// ─── Factory helper ─────────────────────────────────────────────────

function makeContribution(
  overrides: Partial<ConnectorContribution> = {},
): ConnectorContribution {
  return {
    id: 'contrib-1',
    sessionId: 'session-1',
    linkedSessionIds: ['session-1'],
    connectorName: 'my-connector',
    attributionMode: 'anonymous',
    status: 'draft',
    acknowledgedEvents: [],
    createdAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
    ...overrides,
  };
}

// ─── shouldShowContributionSection ──────────────────────────────────

describe('shouldShowContributionSection', () => {
  it('shows section when connected and contribution exists', () => {
    expect(shouldShowContributionSection(true, makeContribution())).toBe(true);
  });

  it('hides section when not connected', () => {
    expect(shouldShowContributionSection(false, makeContribution())).toBe(false);
  });

  it('hides section when contribution is null', () => {
    expect(shouldShowContributionSection(true, null)).toBe(false);
  });

  it('hides section when both not connected and no contribution', () => {
    expect(shouldShowContributionSection(false, null)).toBe(false);
  });

  it('shows section for any contribution status when connected', () => {
    const statuses = [
      'draft',
      'testing',
      'ready_to_submit',
      'submitted',
      'ci_pass',
      'ci_fail',
      'changes_requested',
      'approved',
      'rejected',
      'published',
    ] as const;

    for (const status of statuses) {
      expect(
        shouldShowContributionSection(true, makeContribution({ status })),
      ).toBe(true);
    }
  });
});

// ─── shouldShowShareCta ─────────────────────────────────────────────

describe('shouldShowShareCta', () => {
  it('shows CTA for draft status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'draft' }))).toBe(true);
  });

  it('shows CTA for ready_to_submit status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'ready_to_submit' }))).toBe(true);
  });

  it('hides CTA for testing status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'testing' }))).toBe(false);
  });

  it('hides CTA for submitted status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'submitted' }))).toBe(false);
  });

  it('hides CTA for ci_pass status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'ci_pass' }))).toBe(false);
  });

  it('hides CTA for ci_fail status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'ci_fail' }))).toBe(false);
  });

  it('hides CTA for changes_requested status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'changes_requested' }))).toBe(false);
  });

  it('hides CTA for approved status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'approved' }))).toBe(false);
  });

  it('hides CTA for rejected status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'rejected' }))).toBe(false);
  });

  it('hides CTA for published status', () => {
    expect(shouldShowShareCta(makeContribution({ status: 'published' }))).toBe(false);
  });

  it('hides CTA when contribution is null', () => {
    expect(shouldShowShareCta(null)).toBe(false);
  });
});

// ─── isStuckTestingContribution (Stage 5 recovery affordance) ───────

describe('isStuckTestingContribution', () => {
  const NOW = Date.parse('2026-04-20T12:00:00.000Z');
  const ELEVEN_MIN_AGO = new Date(NOW - 11 * 60 * 1000).toISOString();
  const NINE_MIN_AGO = new Date(NOW - 9 * 60 * 1000).toISOString();
  const HOURS_AGO = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();

  it('returns false when contribution is null', () => {
    expect(isStuckTestingContribution(null, NOW)).toBe(false);
  });

  it('returns false for non-testing statuses even when old', () => {
    expect(
      isStuckTestingContribution(
        makeContribution({ status: 'ready_to_submit', updatedAt: HOURS_AGO }),
        NOW,
      ),
    ).toBe(false);
  });

  it('returns false for testing younger than the 10-minute threshold', () => {
    expect(
      isStuckTestingContribution(
        makeContribution({ status: 'testing', updatedAt: NINE_MIN_AGO }),
        NOW,
      ),
    ).toBe(false);
  });

  it('returns true for testing older than the 10-minute threshold', () => {
    expect(
      isStuckTestingContribution(
        makeContribution({ status: 'testing', updatedAt: ELEVEN_MIN_AGO }),
        NOW,
      ),
    ).toBe(true);
  });

  it('falls back to createdAt when updatedAt is absent', () => {
    const contribution = {
      ...makeContribution({ status: 'testing' }),
      updatedAt: undefined as unknown as string,
      createdAt: HOURS_AGO,
    };
    expect(isStuckTestingContribution(contribution, NOW)).toBe(true);
  });

  it('returns false when both timestamps are unparseable', () => {
    const contribution = {
      ...makeContribution({ status: 'testing' }),
      updatedAt: 'not-a-date',
      createdAt: 'also-bad',
    };
    expect(isStuckTestingContribution(contribution, NOW)).toBe(false);
  });
});
