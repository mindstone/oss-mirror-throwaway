/**
 * Space Goals Reader — extracts goals from pre-parsed space README frontmatter.
 *
 * Pure core-layer service: accepts raw README content strings, returns parsed goals.
 * No file I/O, no Electron imports — safe for desktop, cloud, and mobile surfaces.
 *
 * Recognized frontmatter fields (explicit allowlist — no wildcards):
 * - `personal_goals.this_quarter` → Chief-of-Staff personal goals
 * - `company_goals.this_quarter` → company/org goals
 * - `team_goals.this_quarter`    → team goals
 *
 * Last-reviewed dates (top-level frontmatter fields):
 * - `personal_goals_last_reviewed` → for personal goals
 * - `company_values_last_reviewed` → for company/team spaces
 *
 * @see docs/plans/260407_focus_goals_redesign.md
 */

import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import type { SpaceReadmeInput, SpaceGoalsParseResult } from './spaceGoalsTypes';

export type { SpaceReadmeInput, SpaceGoals, SpaceGoalsParseResult } from './spaceGoalsTypes';

const log = createScopedLogger({ service: 'spaceGoalsReader' });

// ─── Internal Helpers ──────────────────────────────────────────────────

/**
 * Frontmatter keys to search for goals, in order of priority.
 * Only these exact keys are recognized — no wildcard matching.
 */
const GOAL_FIELD_ALLOWLIST = [
  'personal_goals',
  'company_goals',
  'team_goals',
] as const;

/**
 * Validate and normalize a single goal entry.
 * Returns null for malformed entries (missing `goal` string, null, non-object, etc.).
 */
function normalizeGoalEntry(entry: unknown): { goal: string; why?: string } | null {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const obj = entry as Record<string, unknown>;
  if (typeof obj.goal !== 'string' || obj.goal.trim().length === 0) {
    return null;
  }

  const result: { goal: string; why?: string } = { goal: obj.goal.trim() };
  if (typeof obj.why === 'string' && obj.why.trim().length > 0) {
    result.why = obj.why.trim();
  }

  return result;
}

/**
 * Extract `lastReviewed` date from frontmatter attributes.
 * Looks for `personal_goals_last_reviewed` or `company_values_last_reviewed` (top-level).
 * Handles both string and Date values (YAML date parsing may produce Date objects).
 */
function extractLastReviewed(attrs: Record<string, unknown>): string | null {
  const candidates = [
    attrs.personal_goals_last_reviewed,
    attrs.company_values_last_reviewed,
  ];

  for (const raw of candidates) {
    if (raw == null) continue;

    if (raw instanceof Date) {
      return raw.toISOString().split('T')[0]; // YYYY-MM-DD
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  }

  return null;
}

/**
 * Determine if a space is personal (Chief-of-Staff).
 * Matches on spaceType or path (case-insensitive).
 */
function isPersonalSpace(input: SpaceReadmeInput): boolean {
  return (
    input.spaceType === 'chief-of-staff' ||
    input.spacePath.toLowerCase() === 'chief-of-staff'
  );
}

/**
 * Parse a single space README and extract goals from frontmatter.
 * Isolated per-space: parse errors are captured, not thrown.
 */
function parseOneSpace(input: SpaceReadmeInput): SpaceGoalsParseResult {
  const { spaceName, spacePath, spaceType, readmeContent } = input;
  const base = { spaceName, spacePath };

  try {
    const parsed = fm<Record<string, unknown>>(readmeContent);
    const attrs = parsed.attributes;

    // Search allowlisted fields for goals
    let foundGoals: Array<{ goal: string; why?: string }> = [];

    for (const field of GOAL_FIELD_ALLOWLIST) {
      const goalsObj = attrs[field];
      if (goalsObj == null || typeof goalsObj !== 'object' || Array.isArray(goalsObj)) {
        continue;
      }

      const thisQuarter = (goalsObj as Record<string, unknown>).this_quarter;
      if (!Array.isArray(thisQuarter)) {
        continue;
      }

      // Normalize and filter malformed entries
      const valid = thisQuarter
        .map(normalizeGoalEntry)
        .filter((g): g is { goal: string; why?: string } => g !== null);

      if (valid.length > 0) {
        foundGoals = valid;
        break; // Use first matching field (personal_goals > company_goals > team_goals)
      }
    }

    if (foundGoals.length === 0) {
      return { ...base, status: 'no_goals', goals: null };
    }

    return {
      ...base,
      status: 'ok',
      goals: {
        spaceName,
        spacePath,
        spaceType,
        isPersonal: isPersonalSpace(input),
        goals: foundGoals,
        lastReviewed: extractLastReviewed(attrs),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ spacePath, err }, 'Failed to parse space README frontmatter');
    return { ...base, status: 'parse_error', error: message, goals: null };
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Extract goals from all provided space READMEs.
 *
 * Pure function — accepts pre-parsed README content (no file I/O).
 * Each space is parsed in isolation: one malformed README does not affect others.
 *
 * Results are sorted: personal goals first, then alphabetical by space name.
 *
 * @param spaces - Array of space README inputs to scan for goals.
 * @returns Array of parse results, one per input space.
 */
export function extractGoalsFromAllSpaces(spaces: SpaceReadmeInput[]): SpaceGoalsParseResult[] {
  const results = spaces.map(parseOneSpace);

  // Sort: personal spaces first, then alphabetical by space name
  results.sort((a, b) => {
    const aPersonal = a.goals?.isPersonal ?? false;
    const bPersonal = b.goals?.isPersonal ?? false;

    // Personal first
    if (aPersonal && !bPersonal) return -1;
    if (!aPersonal && bPersonal) return 1;

    // Then alphabetical by space name (case-insensitive)
    return a.spaceName.localeCompare(b.spaceName, undefined, { sensitivity: 'base' });
  });

  return results;
}
