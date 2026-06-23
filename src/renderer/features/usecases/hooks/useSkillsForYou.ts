import { useMemo, useState, useEffect, useCallback } from 'react';
import { useSkillQualityInsights } from '@renderer/features/library/hooks/useSkillQualityInsights';
import { useSkillsIndex, type SkillInfo, type SkillsGroup } from '@renderer/features/library/hooks/useSkillsIndex';

export interface RecommendedSkill {
  name: string;
  description: string;
  relativePath: string;
  absolutePath: string;
  category: string;
  /** Score for ranking (higher = more relevant) */
  score: number;
  /** Source of the recommendation */
  source: 'coaching' | 'readme' | 'use_cases' | 'improve';
  /** Number of times the skill has been used */
  usageCount?: number;
  /** Quality score from skill scanner */
  qualityScore?: number;
  /** Highest-impact quality suggestion */
  suggestion?: string;
}

interface SkillSuggestion {
  skillName: string;
  count: number;
  lastSuggestedAt: number;
}

interface UseSkillsForYouResult {
  skills: RecommendedSkill[];
  improveSkills: RecommendedSkill[];
  dismissImproveSkill: (skillName: string) => void;
  loading: boolean;
  error: string | null;
}

const SPARK_SKILLS_DISMISSED_STORAGE_KEY = 'spark-skills-dismissed';
const MAX_IMPROVE_SKILLS = 3;

/**
 * Hook to get personalized skill recommendations.
 * 
 * Priority order:
 * 1. Skills suggested by coaching (skill_opportunity insights)
 * 1.5 Skills needing quality improvements (high usage + low quality)
 * 2. Fallback: Platform/space skills with use_cases (most documented = most useful)
 * 
 * Filters applied:
 * - Exclude skills from Chief-of-Staff (user already knows their own skills)
 * - Exclude platform skills that user has personalized (they clearly know those)
 */
export function useSkillsForYou(maxSkills = 3): UseSkillsForYouResult {
  const { skillsData, loading: skillsLoading, error: skillsError } = useSkillsIndex();
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [dismissedImproveSkills, setDismissedImproveSkills] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(SPARK_SKILLS_DISMISSED_STORAGE_KEY);
      if (!stored) return new Set();
      const parsed = JSON.parse(stored);
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  });

  const { needsAttentionSkills } = useSkillQualityInsights(skillsData?.groups ?? []);

  // Fetch coaching suggestions on mount
  useEffect(() => {
    let cancelled = false;

    window.miscApi.getSuggestedSkills()
      .then(({ suggestions: s }) => {
        if (cancelled) return;
        setSuggestions(s);
        setSuggestionsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSuggestionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SPARK_SKILLS_DISMISSED_STORAGE_KEY,
        JSON.stringify([...dismissedImproveSkills])
      );
    } catch {
      // Ignore localStorage errors
    }
  }, [dismissedImproveSkills]);

  const dismissImproveSkill = useCallback((skillName: string) => {
    setDismissedImproveSkills((prev) => {
      const next = new Set(prev);
      next.add(skillName);
      return next;
    });
  }, []);

  const { skills, improveSkills } = useMemo(() => {
    if (!skillsData?.groups) {
      return { skills: [], improveSkills: [] };
    }

    // Build a map of all skills for quick lookup
    const allSkillsMap = new Map<string, { skill: SkillInfo; group: SkillsGroup }>();
    const personalizedPlatformSkills = new Set<string>(); // Platform skills that have supplements

    for (const group of skillsData.groups) {
      for (const categorySkills of Object.values(group.categories)) {
        for (const skill of categorySkills as SkillInfo[]) {
          // Track skills by name for coaching suggestion matching
          allSkillsMap.set(skill.name.toLowerCase(), { skill, group });
          
          // Check if this is a Chief-of-Staff supplement for a platform skill
          if (group.type === 'space' && skill.relativePath.includes('Chief-of-Staff')) {
            // If it has a 'supplements' frontmatter, the platform skill is personalized
            const supplements = (skill.frontmatter as unknown as Record<string, unknown>)?.supplements;
            if (typeof supplements === 'string') {
              // Extract skill name from the supplements path
              const match = supplements.match(/([^/]+)\/SKILL\.md$/i);
              if (match) {
                personalizedPlatformSkills.add(match[1].toLowerCase());
              }
            }
          }
        }
      }
    }

    // Filter function: should we exclude this skill?
    const shouldExclude = (skill: SkillInfo, group: SkillsGroup): boolean => {
      const pathLower = skill.relativePath.toLowerCase();
      
      // Exclude Chief-of-Staff skills (user's own skills - they already know these)
      if (group.type === 'space' && pathLower.includes('chief-of-staff')) {
        return true;
      }
      // Exclude platform skills that user has personalized
      if (group.type === 'platform' && personalizedPlatformSkills.has(skill.name.toLowerCase())) {
        return true;
      }
      return false;
    };

    const coachingRecommendations: RecommendedSkill[] = [];

    // Priority 1: Skills from coaching suggestions
    for (const suggestion of suggestions) {
      const match = allSkillsMap.get(suggestion.skillName.toLowerCase());
      if (match && !shouldExclude(match.skill, match.group)) {
        const { skill } = match;
        if (skill.frontmatter?.description) {
          coachingRecommendations.push({
            name: skill.name,
            description: skill.frontmatter.description,
            relativePath: skill.relativePath,
            absolutePath: skill.absolutePath,
            category: formatCategory(skill.category),
            score: 1000 + suggestion.count, // High base score for coaching
            source: 'coaching',
            usageCount: skill.usageCount,
            qualityScore: skill.qualityScore,
            suggestion: skill.qualityTopImprovement?.suggestion,
          });
        }
      }
    }

    const improveCandidates: RecommendedSkill[] = needsAttentionSkills
      .filter((skill) => {
        if (dismissedImproveSkills.has(skill.name)) return false;
        if (!skill.frontmatter?.description) return false;
        return !shouldExclude(skill, skill.group);
      })
      .map(({ name, absolutePath, relativePath, category, frontmatter, usageCount, qualityScore, qualityTopImprovement }) => ({
        name,
        description: frontmatter?.description ?? 'Could use some love.',
        relativePath,
        absolutePath,
        category: formatCategory(category),
        score: (usageCount ?? 0) - (qualityScore ?? 0),
        source: 'improve' as const,
        usageCount,
        qualityScore,
        suggestion: qualityTopImprovement?.suggestion,
      }))
      .sort((a, b) => {
        const qualityDiff = (a.qualityScore ?? 0) - (b.qualityScore ?? 0);
        if (qualityDiff !== 0) return qualityDiff;

        const usageDiff = (b.usageCount ?? 0) - (a.usageCount ?? 0);
        if (usageDiff !== 0) return usageDiff;

        return a.name.localeCompare(b.name);
      });

    // Priority 2: Fallback to skills with use_cases (platform + space)
    const fallbackCandidates: RecommendedSkill[] = [];
    
    for (const group of skillsData.groups) {
      // Include platform and space skills (but not workspace root)
      if (group.type !== 'platform' && group.type !== 'space') continue;
      
      for (const categorySkills of Object.values(group.categories)) {
        for (const skill of categorySkills as SkillInfo[]) {
          if (shouldExclude(skill, group)) continue;
          if (!skill.frontmatter?.description) continue;
          
          const useCaseCount = skill.frontmatter.use_cases?.length ?? 0;
          if (useCaseCount > 0) {
            fallbackCandidates.push({
              name: skill.name,
              description: skill.frontmatter.description,
              relativePath: skill.relativePath,
              absolutePath: skill.absolutePath,
              category: formatCategory(skill.category),
              score: useCaseCount,
              source: 'use_cases',
              usageCount: skill.usageCount,
              qualityScore: skill.qualityScore,
              suggestion: skill.qualityTopImprovement?.suggestion,
            });
          }
        }
      }
    }

    // Sort fallbacks by score
    fallbackCandidates.sort((a, b) => b.score - a.score);

    const prioritizedRecommendations: RecommendedSkill[] = [];
    const addedPaths = new Set<string>();

    const addSkill = (candidate: RecommendedSkill) => {
      if (addedPaths.has(candidate.relativePath)) return;
      prioritizedRecommendations.push(candidate);
      addedPaths.add(candidate.relativePath);
    };

    // Priority 1: coaching
    coachingRecommendations.forEach(addSkill);
    // Priority 1.5: improve (high-usage + low-quality)
    improveCandidates.forEach(addSkill);
    // Priority 2: use_cases fallback
    fallbackCandidates.forEach(addSkill);

    return {
      skills: prioritizedRecommendations.slice(0, maxSkills),
      improveSkills: improveCandidates.slice(0, MAX_IMPROVE_SKILLS),
    };
  }, [skillsData, suggestions, maxSkills, needsAttentionSkills, dismissedImproveSkills]);

  return {
    skills,
    improveSkills,
    dismissImproveSkill,
    loading: skillsLoading || suggestionsLoading,
    error: skillsError,
  };
}

function formatCategory(category: string): string {
  return category
    .split(/[-_\/]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
