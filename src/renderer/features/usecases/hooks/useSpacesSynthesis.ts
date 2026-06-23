/**
 * useSpacesSynthesis - Hook for fetching AI-generated activity synthesis
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { SpacesSynthesis } from '@shared/ipc/channels/dashboard';

type GenerationPhase = 
  | 'idle'
  | 'reading'
  | 'counting'
  | 'connecting'
  | 'done';

const THINKING_MESSAGES: Record<GenerationPhase, string> = {
  idle: '',
  reading: 'Reading through your memories...',
  counting: 'Found updates across your spaces...',
  connecting: 'Connecting the dots...',
  done: '',
};

export function useSpacesSynthesis(focus: string | undefined): {
  synthesis: SpacesSynthesis | null;
  isLoading: boolean;
  isGenerating: boolean;
  generationPhase: GenerationPhase;
  thinkingMessage: string;
  error: string | null;
  refresh: () => void;
} {
  const [synthesis, setSynthesis] = useState<SpacesSynthesis | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const phaseTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearPhaseTimer = useCallback(() => {
    if (phaseTimerRef.current) {
      clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
  }, []);

  const startThinkingAnimation = useCallback(() => {
    setGenerationPhase('reading');
    
    // Progress through phases
    phaseTimerRef.current = setTimeout(() => {
      setGenerationPhase('counting');
      phaseTimerRef.current = setTimeout(() => {
        setGenerationPhase('connecting');
      }, 2000);
    }, 1500);
  }, []);

  const fetchSynthesis = useCallback(async (forceRegenerate = false) => {
    if (!focus) return;

    setIsLoading(true);
    setError(null);

    if (forceRegenerate) {
      setIsGenerating(true);
      startThinkingAnimation();
    }

    try {
      const result = await window.dashboardApi.getSpacesSynthesis({ 
        focus, 
        forceRegenerate 
      });
      setSynthesis(result);
      setGenerationPhase('done');
    } catch (err) {
      console.error('Failed to fetch synthesis:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate synthesis');
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
      clearPhaseTimer();
      // Reset phase after a brief moment
      setTimeout(() => setGenerationPhase('idle'), 500);
    }
  }, [focus, startThinkingAnimation, clearPhaseTimer]);

  // Initial fetch when focus is set
  useEffect(() => {
    if (focus) {
      void fetchSynthesis(false);
    }
  }, [focus, fetchSynthesis]);

  // Cleanup
  useEffect(() => {
    return () => clearPhaseTimer();
  }, [clearPhaseTimer]);

  const refresh = useCallback(() => {
    void fetchSynthesis(true);
  }, [fetchSynthesis]);

  return {
    synthesis,
    isLoading,
    isGenerating,
    generationPhase,
    thinkingMessage: THINKING_MESSAGES[generationPhase],
    error,
    refresh,
  };
}
