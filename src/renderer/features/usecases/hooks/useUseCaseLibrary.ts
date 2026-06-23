import { useState, useEffect, useCallback } from 'react';
import type { UseCaseRecordIpc, GroupedUseCasesIpc } from '@shared/ipc/channels/useCaseLibrary';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

interface UseUseCaseLibraryResult {
  useCases: UseCaseRecordIpc[];
  groupedUseCases: GroupedUseCasesIpc | null;
  totalCount: number;
  isLoading: boolean;
  error: string | null;
  recordUsage: (id: string) => void;
  markSeen: (id: string) => void;
  dismissUseCase: (id: string) => void;
  refresh: () => void;
}

/**
 * Hook to access the use case library from the renderer.
 * Fetches prioritized use cases for display and provides methods to record usage.
 * Auto-refreshes when new use cases are generated (dashboard:use-cases-ready event).
 */
export function useUseCaseLibrary(limit: number = 3): UseUseCaseLibraryResult {
  const [useCases, setUseCases] = useState<UseCaseRecordIpc[]>([]);
  const [groupedUseCases, setGroupedUseCases] = useState<GroupedUseCasesIpc | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUseCases = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const [displayResult, groupedResult] = await Promise.all([
        window.useCaseLibraryApi.getForDisplay({ limit }),
        window.useCaseLibraryApi.getGrouped({})
      ]);
      setUseCases(displayResult.useCases);
      setGroupedUseCases(groupedResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load your use cases");
      setUseCases([]);
      setGroupedUseCases(null);
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  const totalCount = groupedUseCases
    ? groupedUseCases.new.length + groupedUseCases.frequent.length + groupedUseCases.other.length
    : useCases.length;

  // Initial fetch
  useEffect(() => {
    void fetchUseCases();
  }, [fetchUseCases]);

  // Listen for use cases ready event (from background generation or onboarding)
  useIpcEvent(window.api.onUseCasesReady, () => {
    void fetchUseCases();
  }, [fetchUseCases]);

  // Also listen for coach completion (use cases may finish before or after coach)
  useEffect(() => {
    const handler = () => void fetchUseCases();
    window.addEventListener('onboarding-coach-complete', handler);
    return () => window.removeEventListener('onboarding-coach-complete', handler);
  }, [fetchUseCases]);

  const recordUsage = useCallback((id: string) => {
    void window.useCaseLibraryApi.recordUsage({ id });
  }, []);

  const markSeen = useCallback((id: string) => {
    void window.useCaseLibraryApi.markSeen({ id });
    // Optimistically update local state
    setUseCases(prev => prev.map(uc => 
      uc.id === id ? { ...uc, isNew: false } : uc
    ));
  }, []);

  const dismissUseCase = useCallback((id: string) => {
    // Optimistically remove from local state so the UI updates immediately.
    // We intentionally do NOT re-fetch here — the carousel's composition logic
    // backfills from other content types (insights, suggestions) so the user
    // sees varied content rather than just another use case.
    setUseCases(prev => prev.filter(uc => uc.id !== id));
    setGroupedUseCases(prev => {
      if (!prev) return prev;
      return {
        new: prev.new.filter(uc => uc.id !== id),
        frequent: prev.frequent.filter(uc => uc.id !== id),
        other: prev.other.filter(uc => uc.id !== id),
      };
    });
    // Persist dismissal so it survives page refresh
    void window.useCaseLibraryApi.dismiss({ id });
  }, []);

  const refresh = useCallback(() => {
    void fetchUseCases();
  }, [fetchUseCases]);

  return {
    useCases,
    groupedUseCases,
    totalCount,
    isLoading,
    error,
    recordUsage,
    markSeen,
    dismissUseCase,
    refresh
  };
}
