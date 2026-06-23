export type MeetingUtility = 'productive' | 'blocker' | 'noise' | 'travel';

export interface PrepGoalAlignment {
  goal: string;
  space: string;
}

export interface PrepEnrichment {
  goalAlignment: PrepGoalAlignment[];
  meetingUtility: MeetingUtility;
  enrichedAt: string;
  enrichedBy: string;
}

/**
 * Canonical mapping between TypeScript field names and prep frontmatter YAML fields.
 */
export const PREP_ENRICHMENT_FIELDS = {
  goalAlignment: 'goal_alignment',
  meetingUtility: 'meeting_utility',
  enrichedAt: 'enriched_at',
  enrichedBy: 'enriched_by',
} as const;
