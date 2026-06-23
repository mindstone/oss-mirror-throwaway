import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillQualityBand } from '../utils/skillQualityUtils';
import type { ExampleMeta } from './useSkillsIndex';

export type SkillQualityBreakdown = Record<string, { score: number; max: number }>;

export interface SkillBreakdownQualitySnapshot {
  total: number;
  band: SkillQualityBand;
  topImprovement?: {
    dimension: string;
    suggestion: string;
  };
  breakdown?: SkillQualityBreakdown;
}

interface UseSkillBreakdownResult {
  quality: SkillBreakdownQualitySnapshot | null;
  breakdown: SkillQualityBreakdown | null;
  exampleMetas: ExampleMeta[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSkillBreakdown(skillRelativePath: string | null): UseSkillBreakdownResult {
  const [quality, setQuality] = useState<SkillBreakdownQualitySnapshot | null>(null);
  const [exampleMetas, setExampleMetas] = useState<ExampleMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!skillRelativePath) {
      requestVersionRef.current += 1;
      setQuality(null);
      setExampleMetas([]);
      setError(null);
      setLoading(false);
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setLoading(true);
    setError(null);

    try {
      const [qualityResult, metasResult] = await Promise.all([
        window.libraryApi.computeSkillQuality({ skillRelativePath }),
        window.libraryApi.getExampleMetas({ skillRelativePath }),
      ]);

      if (requestVersionRef.current !== requestVersion) {
        return;
      }

      setQuality(
        qualityResult
          ? {
              total: qualityResult.total,
              band: qualityResult.band,
              topImprovement: qualityResult.topImprovement,
              breakdown: qualityResult.breakdown,
            }
          : null,
      );

      if (!metasResult.success) {
        setExampleMetas([]);
        setError(metasResult.error ?? 'Failed to load example metadata.');
        return;
      }

      setExampleMetas(metasResult.metas);
    } catch (err) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }

      setQuality(null);
      setExampleMetas([]);
      setError(err instanceof Error ? err.message : 'Failed to load skill breakdown.');
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setLoading(false);
      }
    }
  }, [skillRelativePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    quality,
    breakdown: quality?.breakdown ?? null,
    exampleMetas,
    loading,
    error,
    refresh,
  };
}
