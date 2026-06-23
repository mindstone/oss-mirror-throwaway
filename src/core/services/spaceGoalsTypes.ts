/**
 * Space Goals Types — extracted from spaceGoalsReader for cross-surface type sharing.
 *
 * These types are safe to import from renderer (no @core/logger dependency).
 *
 * @see src/core/services/spaceGoalsReader.ts — implementation
 */

/** Raw README content for a single space, ready for goal extraction. */
export interface SpaceReadmeInput {
  /** Display name of the space (folder name). */
  spaceName: string;
  /** Relative path within workspace (e.g. "Chief-of-Staff", "work/Acme"). */
  spacePath: string;
  /** Space type as classified by spaceService (e.g. "chief-of-staff", "company", "team"). */
  spaceType: string;
  /** Raw README.md content (frontmatter + body). */
  readmeContent: string;
}

/** Extracted goals for a single space. */
export interface SpaceGoals {
  /** Display name of the space. */
  spaceName: string;
  /** Relative path within workspace. */
  spacePath: string;
  /** Space type. */
  spaceType: string;
  /** True for Chief-of-Staff spaces (personal goals). */
  isPersonal: boolean;
  /** Parsed goals from frontmatter `this_quarter` arrays. */
  goals: Array<{ goal: string; why?: string }>;
  /** ISO date string from `personal_goals_last_reviewed` or `company_values_last_reviewed`, or null. */
  lastReviewed: string | null;
}

/** Result of parsing a single space's README for goals. */
export interface SpaceGoalsParseResult {
  /** Display name of the space. */
  spaceName: string;
  /** Relative path within workspace. */
  spacePath: string;
  /** Parse outcome: 'ok' = goals found, 'no_goals' = valid parse but no goal fields, 'parse_error' = YAML/parse failure. */
  status: 'ok' | 'no_goals' | 'parse_error';
  /** Error message when status is 'parse_error'. */
  error?: string;
  /** Extracted goals (null when status is 'no_goals' or 'parse_error'). */
  goals: SpaceGoals | null;
}
