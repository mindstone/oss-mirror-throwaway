/**
 * useErrorRecovery - Hook for error recovery evaluation flow
 *
 * Manages state for the error recovery feature where Rebel evaluates
 * whether it can help fix an error before presenting options to the user.
 */

import { useState, useEffect, useCallback } from 'react';
import type { SafeModeErrorCategory } from '@shared/types';

export type ErrorRecoveryStatus = 'idle' | 'evaluating' | 'can_help' | 'cannot_help' | 'evaluation_failed';

export interface ErrorRecoveryEvaluation {
  status: ErrorRecoveryStatus;
  canHelp: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  suggestedAction?: string;
  contextForConversation: {
    filesExamined: string[];
    relevantExcerpts: Record<string, string>;
    healthCheckSummary?: string;
    diagnosticInfo?: string;
  };
  evaluationDurationMs?: number;
  error?: string;
}

export interface ErrorRecoveryState {
  evaluationId: string | null;
  status: ErrorRecoveryStatus;
  errorCategory: SafeModeErrorCategory | null;
  evaluation: ErrorRecoveryEvaluation | null;
  startedAt: number | null;
  quipIndex: number;
}

const initialState: ErrorRecoveryState = {
  evaluationId: null,
  status: 'idle',
  errorCategory: null,
  evaluation: null,
  startedAt: null,
  quipIndex: 0,
};

interface UseErrorRecoveryOptions {
  onStartFixConversation?: (prompt: string, errorCategory: SafeModeErrorCategory) => void;
}

interface UseErrorRecoveryReturn {
  state: ErrorRecoveryState;
  evaluate: (errorCategory: SafeModeErrorCategory, errorMessage?: string, context?: Record<string, unknown>) => Promise<void>;
  dismiss: () => void;
  getFixPrompt: () => Promise<{ prompt: string | null; errorCategory: SafeModeErrorCategory | null }>;
  handleLetRebelFix: () => Promise<void>;
  handleAskAnyway: () => void;
}

export function useErrorRecovery(options: UseErrorRecoveryOptions = {}): UseErrorRecoveryReturn {
  const { onStartFixConversation } = options;
  const [state, setState] = useState<ErrorRecoveryState>(initialState);

  // Subscribe to error recovery state updates from main process
  useEffect(() => {
    const unsubscribe = window.api.onErrorRecoveryState((newState) => {
      setState(newState);
    });

    // Fetch initial state
    window.errorRecoveryApi.getState().then(setState).catch(console.error);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);

  const evaluate = useCallback(
    async (
      errorCategory: SafeModeErrorCategory,
      errorMessage?: string,
      context?: Record<string, unknown>
    ) => {
      try {
        // Optimistically set evaluating state
        setState((prev) => ({
          ...prev,
          status: 'evaluating',
          errorCategory,
          startedAt: Date.now(),
        }));

        const result = await window.errorRecoveryApi.evaluate({
          errorCategory,
          errorMessage,
          context,
        });

        // State will be updated via subscription, but set locally for immediate feedback
        setState((prev) => ({
          ...prev,
          status: result.status,
          evaluation: result,
        }));
      } catch (error) {
        console.error('Error recovery evaluation failed:', error);
        setState((prev) => ({
          ...prev,
          status: 'evaluation_failed',
          evaluation: {
            status: 'evaluation_failed',
            canHelp: false,
            confidence: 'low',
            summary: 'Something went wrong during evaluation.',
            contextForConversation: {
              filesExamined: [],
              relevantExcerpts: {},
            },
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    []
  );

  const dismiss = useCallback(() => {
    window.errorRecoveryApi.dismiss().catch(console.error);
    setState(initialState);
  }, []);

  const getFixPrompt = useCallback(async () => {
    try {
      return await window.errorRecoveryApi.getFixPrompt();
    } catch (error) {
      console.error('Failed to get fix prompt:', error);
      return { prompt: null, errorCategory: null };
    }
  }, []);

  const handleLetRebelFix = useCallback(async () => {
    const { prompt, errorCategory } = await getFixPrompt();
    if (prompt && errorCategory && onStartFixConversation) {
      onStartFixConversation(prompt, errorCategory);
    }
    dismiss();
  }, [getFixPrompt, onStartFixConversation, dismiss]);

  const handleAskAnyway = useCallback(() => {
    // Start a basic troubleshooting conversation without evaluation context
    if (state.errorCategory && onStartFixConversation) {
      const basicPrompt = `I'm having a ${state.errorCategory.replace(/_/g, ' ')} issue. Can you help me troubleshoot?`;
      onStartFixConversation(basicPrompt, state.errorCategory);
    }
    dismiss();
  }, [state.errorCategory, onStartFixConversation, dismiss]);

  return {
    state,
    evaluate,
    dismiss,
    getFixPrompt,
    handleLetRebelFix,
    handleAskAnyway,
  };
}
