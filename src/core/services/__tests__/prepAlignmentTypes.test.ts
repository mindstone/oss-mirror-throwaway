import { describe, expect, it } from 'vitest';
import {
  PREP_ENRICHMENT_FIELDS,
  type MeetingUtility,
  type PrepEnrichment,
} from '../prepAlignmentTypes';

describe('prepAlignmentTypes', () => {
  it('exposes the canonical YAML field mapping', () => {
    expect(PREP_ENRICHMENT_FIELDS).toEqual({
      goalAlignment: 'goal_alignment',
      meetingUtility: 'meeting_utility',
      enrichedAt: 'enriched_at',
      enrichedBy: 'enriched_by',
    });
  });

  it('accepts all supported meeting utility values', () => {
    const values: MeetingUtility[] = ['productive', 'blocker', 'noise', 'travel'];
    expect(values).toEqual(['productive', 'blocker', 'noise', 'travel']);
  });

  it('matches the expected PrepEnrichment shape', () => {
    const enrichment: PrepEnrichment = {
      goalAlignment: [
        { goal: 'Ship v1', space: 'Mindstone' },
        { goal: 'Protect deep work', space: 'Personal' },
      ],
      meetingUtility: 'productive',
      enrichedAt: '2026-04-09T19:00:00.000Z',
      enrichedBy: 'focus-weekly-prep',
    };

    expect(enrichment.goalAlignment).toHaveLength(2);
    expect(enrichment.meetingUtility).toBe('productive');
    expect(enrichment.enrichedBy).toBe('focus-weekly-prep');
  });
});
