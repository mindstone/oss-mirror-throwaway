import { useMemo, useState, useCallback } from 'react';
import type { SkillInfo, SkillsGroup } from './useSkillsIndex';

export interface QualityInsightSkill extends SkillInfo {
  group: SkillsGroup;
}

interface UseSkillQualityInsightsResult {
  needsAttentionSkills: QualityInsightSkill[];
  staleSkills: QualityInsightSkill[];
  dismissStaleSkill: (skillName: string) => void;
}

const NEEDS_ATTENTION_THRESHOLD = 50;
const NEEDS_ATTENTION_MIN_USAGE = 3;
const MAX_NEEDS_ATTENTION_SKILLS = 4;
const SKILL_STALENESS_DAYS = 30;
const STALENESS_THRESHOLD_MS = SKILL_STALENESS_DAYS * 24 * 60 * 60 * 1000;
const MAX_STALE_SKILLS = 6;

export function useSkillQualityInsights(groups: SkillsGroup[]): UseSkillQualityInsightsResult {
  const [dismissedStale, setDismissedStale] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('skills-dismissed-stale');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const dismissStaleSkill = useCallback((skillName: string) => {
    setDismissedStale(prev => {
      const next = new Set(prev);
      next.add(skillName);
      localStorage.setItem('skills-dismissed-stale', JSON.stringify([...next]));
      return next;
    });
  }, []);

  const needsAttentionSkills = useMemo(() => {
    const candidates: QualityInsightSkill[] = [];

    for (const group of groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          const usage = skill.usageCount ?? 0;
          if (
            skill.qualityScore !== undefined &&
            skill.qualityScore < NEEDS_ATTENTION_THRESHOLD &&
            usage >= NEEDS_ATTENTION_MIN_USAGE
          ) {
            candidates.push({ ...skill, group });
          }
        }
      }
    }

    return candidates
      .sort((a, b) => {
        const qualityDiff = (a.qualityScore ?? 0) - (b.qualityScore ?? 0);
        if (qualityDiff !== 0) return qualityDiff;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_NEEDS_ATTENTION_SKILLS);
  }, [groups]);

  const staleSkills = useMemo(() => {
    const now = Date.now();
    const candidates: QualityInsightSkill[] = [];

    for (const group of groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          if (dismissedStale.has(skill.name)) continue;
          if (skill.qualityScore === undefined || skill.qualityScore >= NEEDS_ATTENTION_THRESHOLD) continue;
          if (!skill.lastUsedAt) continue;
          if (now - skill.lastUsedAt < STALENESS_THRESHOLD_MS) continue;

          candidates.push({ ...skill, group });
        }
      }
    }

    return candidates
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
      .slice(0, MAX_STALE_SKILLS);
  }, [groups, dismissedStale]);

  return { needsAttentionSkills, staleSkills, dismissStaleSkill };
}
