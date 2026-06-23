import { useEffect, useRef, useCallback, useState } from 'react';
import { QUALITY_BAND_CONFIG, type SkillQualityBand } from '../utils/skillQualityUtils';

interface SkillImprovementToastDeps {
  showToast: (props: { title: string; description?: string; action?: { label: string; onClick: () => void }; cancel?: { label: string; onClick: () => void }; duration?: number }) => void;
  onTrySkill: (skillPath: string) => void;
  onCompareWithLastUse?: (skillPath: string, sessionId: string) => void;
}

function formatBandLabel(band: SkillQualityBand): string {
  return QUALITY_BAND_CONFIG[band].label;
}

/**
 * Listens for `library:skill-improvement-complete` broadcasts and shows
 * a toast when a doctor session finishes improving a skill.
 *
 * Call `cacheScore(skillPath, score)` from the library to enable before/after deltas.
 * Without cached scores, the toast shows "Now Strong (72)" format.
 */
export function useSkillImprovementToast(deps: SkillImprovementToastDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [scoreCache] = useState(() => new Map<string, number>());

  const cacheScore = useCallback((skillPath: string, score: number) => {
    scoreCache.set(skillPath.replace(/\\/g, '/'), score);
  }, [scoreCache]);

  useEffect(() => {
    const cleanup = window.api.onSkillImprovementComplete?.((data) => {
      const { skillName, skillPath, scoreAfter, bandAfter, lastSessionId } = data;
      const { showToast, onTrySkill, onCompareWithLastUse } = depsRef.current;

      const normalizedPath = skillPath.replace(/\\/g, '/');
      const scoreBefore = scoreCache.get(normalizedPath);
      const bandAfterTyped = bandAfter as SkillQualityBand;

      let description: string;
      if (scoreBefore !== undefined && scoreAfter > scoreBefore) {
        description = `${scoreBefore} \u2192 ${scoreAfter} \u2014 ${formatBandLabel(bandAfterTyped)}`;
      } else {
        description = `Now ${formatBandLabel(bandAfterTyped)} (${scoreAfter})`;
      }

      // Update cache with new score (cap at 50 entries)
      scoreCache.set(normalizedPath, scoreAfter);
      if (scoreCache.size > 50) {
        const firstKey = scoreCache.keys().next().value;
        if (firstKey) scoreCache.delete(firstKey);
      }

      showToast({
        title: `${skillName} improved`,
        description,
        action: {
          label: 'Try it now',
          onClick: () => onTrySkill(skillPath),
        },
        cancel: lastSessionId && onCompareWithLastUse
          ? { label: 'Compare with last use', onClick: () => onCompareWithLastUse(skillPath, lastSessionId) }
          : undefined,
        duration: 10000,
      });
    });

    return () => { cleanup?.(); };
  }, [scoreCache]);

  return { cacheScore };
}
