/**
 * Hook to fetch actual personal goals from Chief-of-Staff frontmatter.
 * Returns the goal text, status, and last reviewed date.
 * Auto-refreshes when onboarding completes (dashboard:use-cases-ready event).
 */

import { useState, useEffect, useCallback } from 'react';
import type { PersonalGoals } from '@shared/ipc/channels/dashboard';

interface UsePersonalGoalsResult {
  goals: PersonalGoals | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePersonalGoals(): UsePersonalGoalsResult {
  const [goals, setGoals] = useState<PersonalGoals | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGoals = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await window.dashboardApi.getPersonalGoals();
      setGoals(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your goals");
      setGoals({ thisQuarter: [], lastReviewed: null, status: 'not_set' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchGoals();
  }, [fetchGoals]);

  // Listen for onboarding coach completion (goals are written during coach conversation)
  useEffect(() => {
    const handler = () => void fetchGoals();
    window.addEventListener('onboarding-coach-complete', handler);
    return () => window.removeEventListener('onboarding-coach-complete', handler);
  }, [fetchGoals]);

  return {
    goals,
    isLoading,
    error,
    refresh: fetchGoals,
  };
}
