/**
 * useAi — Plugin hook for constrained LLM access
 *
 * Provides `summarize`, `extractObject`, and `generate` operations backed by
 * the Behind-the-Scenes model via IPC. Each call is rate-limited per plugin
 * (server-side sliding window). The returned `ai` object is stable across
 * renders; `isProcessing` tracks concurrent in-flight calls.
 *
 * Unlike useSources/useMemorySearch, this hook does NOT debounce — AI calls
 * are user-triggered, not reactive.
 *
 * @see src/main/ipc/pluginHandlers.ts — ai-summarize/ai-extract/ai-generate handlers
 * @see src/core/services/pluginAiRateLimiter.ts — sliding-window rate limiter
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { usePluginId } from './PluginContext';
import type { AiApi, UseAiResult } from './types';

export function useAi(): UseAiResult {
  const pluginId = usePluginId();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeCallsRef = useRef(0);

  /**
   * Wraps an async IPC call with processing-state tracking.
   * Increments/decrements a counter so concurrent calls keep `isProcessing`
   * true until the last one resolves. Re-throws errors so callers can
   * also handle them via try/catch.
   */
  const trackCall = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    activeCallsRef.current++;
    setIsProcessing(true);
    setError(null);
    try {
      const result = await fn();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed';
      setError(message);
      throw err;
    } finally {
      activeCallsRef.current--;
      if (activeCallsRef.current === 0) {
        setIsProcessing(false);
      }
    }
  }, []);

  const summarize = useCallback(
    async (text: string, options?: { maxLength?: number }): Promise<string> => {
      return trackCall(async () => {
        if (typeof window === 'undefined' || !window.pluginsApi?.aiSummarize) {
          throw new Error('AI summarize API not available');
        }
        const response = await window.pluginsApi.aiSummarize({
          pluginId,
          text,
          ...(options?.maxLength != null ? { maxLength: options.maxLength } : {}),
        });
        return response.summary;
      });
    },
    [pluginId, trackCall],
  );

  const extractObject = useCallback(
    async <T>(
      text: string,
      schema: { name: string; description: string; properties: Record<string, unknown> },
    ): Promise<T> => {
      return trackCall(async () => {
        if (typeof window === 'undefined' || !window.pluginsApi?.aiExtract) {
          throw new Error('AI extract API not available');
        }
        const response = await window.pluginsApi.aiExtract({
          pluginId,
          text,
          schema,
        });
        return response.result as T;
      });
    },
    [pluginId, trackCall],
  );

  const generate = useCallback(
    async (prompt: string, options?: { maxTokens?: number }): Promise<string> => {
      return trackCall(async () => {
        if (typeof window === 'undefined' || !window.pluginsApi?.aiGenerate) {
          throw new Error('AI generate API not available');
        }
        const response = await window.pluginsApi.aiGenerate({
          pluginId,
          prompt,
          ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
        });
        return response.text;
      });
    },
    [pluginId, trackCall],
  );

  const ai = useMemo<AiApi>(
    () => ({ summarize, extractObject, generate }),
    [summarize, extractObject, generate],
  );

  return { ai, isProcessing, error };
}
