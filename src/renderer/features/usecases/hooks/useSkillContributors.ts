/**
 * useSkillContributors
 *
 * Aggregates contributors from skill frontmatter for the Thank You Board.
 * Extracts from the `contributed` and `author` fields.
 * Returns which skills each person contributed to.
 */

import { useMemo } from 'react';
import { useSkillsIndex } from '@renderer/features/library/hooks/useSkillsIndex';

export interface Contributor {
  name: string;
  created: string[];   // Skills they authored
  improved: string[];  // Skills they contributed to (but didn't create)
}

interface UseSkillContributorsResult {
  contributors: Contributor[];
  loading: boolean;
}

/**
 * Normalize contributor name:
 * - Strip parenthetical notes like "(original author)" or "(ported to...)"
 * - Trim whitespace
 */
function normalizeName(raw: string): string | null {
  // Strip anything in parentheses
  const cleaned = raw.replace(/\s*\([^)]*\)/g, '').trim();
  
  // Skip empty, "Rebel", or system-like entries
  if (!cleaned) return null;
  if (cleaned.toLowerCase() === 'rebel') return null;
  if (cleaned.toLowerCase() === 'rebel (claude)') return null;
  if (cleaned.toLowerCase().includes('ported from')) return null;
  
  return cleaned;
}

/**
 * Check if a date string is within the last N days.
 */
function isWithinDays(dateStr: string | undefined, days: number): boolean {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

/**
 * Extract and aggregate contributors from all skills.
 * Only includes skills modified in the last 30 days.
 * Returns contributors with created/improved skill lists, sorted by total contribution count.
 */
export function useSkillContributors(): UseSkillContributorsResult {
  const { skillsData, loading } = useSkillsIndex();

  const contributors = useMemo(() => {
    if (!skillsData) return [];

    // Map: normalized name -> { created: Set, improved: Set }
    const contributorMap = new Map<string, { created: Set<string>; improved: Set<string> }>();

    const getEntry = (name: string) => {
      let entry = contributorMap.get(name);
      if (!entry) {
        entry = { created: new Set(), improved: new Set() };
        contributorMap.set(name, entry);
      }
      return entry;
    };

    for (const group of skillsData.groups) {
      // Skip platform skills - only show user/team contributions
      if (group.type === 'platform') continue;

      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          const fm = skill.frontmatter;
          if (!fm) continue;

          // Only include skills modified in the last 30 days
          if (!isWithinDays(fm.last_modified_at, 30) && !isWithinDays(fm.last_updated, 30)) {
            continue;
          }

          const skillName = skill.name;
          const authorName = fm.author ? normalizeName(fm.author) : null;

          // Track author as creator
          if (authorName) {
            getEntry(authorName).created.add(skillName);
          }

          // Track contributors as improvers (unless they're also the author)
          if (fm.contributed) {
            for (const contributor of fm.contributed) {
              const name = normalizeName(contributor);
              if (name && name !== authorName) {
                getEntry(name).improved.add(skillName);
              }
            }
          }
        }
      }
    }

    // Convert to array and sort by total contribution count (descending)
    return Array.from(contributorMap.entries())
      .map(([name, { created, improved }]) => ({
        name,
        created: Array.from(created).sort(),
        improved: Array.from(improved).sort(),
      }))
      .sort((a, b) => (b.created.length + b.improved.length) - (a.created.length + a.improved.length));
  }, [skillsData]);

  return { contributors, loading };
}
