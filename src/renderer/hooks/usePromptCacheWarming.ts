/**
 * usePromptCacheWarming - JIT Anthropic prompt cache warming
 *
 * Warms the Anthropic prompt cache when the user focuses the composer,
 * if the cache has likely expired (>5 min since last API call).
 *
 * This is a fire-and-forget optimization - we don't block on warmup
 * and cancel immediately if the user sends a message.
 *
 * @see docs/plans/finished/260131_jit_prompt_cache_warming.md
 */

import { useCallback, useRef, useEffect } from 'react';

/** Time threshold for cache expiry (5 minutes in ms) */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface UsePromptCacheWarmingOptions {
  /** Is Super-MCP ready? Warmup requires tools to be available */
  superMcpReady: boolean;
  /** Is the agent currently busy? Don't warm during active turns */
  isBusy: boolean;
}

export interface UsePromptCacheWarmingResult {
  /** Trigger warmup check - call this on composer focus */
  triggerWarmupIfNeeded: () => void;
  /** Cancel any in-progress warmup - call this when user sends message */
  cancelWarmup: () => void;
}

/**
 * Hook for JIT prompt cache warming.
 *
 * Usage:
 * ```tsx
 * const { triggerWarmupIfNeeded, cancelWarmup } = usePromptCacheWarming({
 *   superMcpReady: true,
 *   isBusy: false,
 * });
 *
 * // On composer focus
 * triggerWarmupIfNeeded();
 *
 * // On message send
 * cancelWarmup();
 * ```
 */
export function usePromptCacheWarming({
  superMcpReady,
  isBusy,
}: UsePromptCacheWarmingOptions): UsePromptCacheWarmingResult {
  const isWarmingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastApiCallTimeRef = useRef<number | null>(null);

  // Update last API call time when a turn completes
  // This is tracked here for the frontend to decide whether to trigger warmup
  // The actual timestamp is also tracked in main process
  const updateLastApiCallTime = useCallback(() => {
    lastApiCallTimeRef.current = Date.now();
  }, []);

  // When a turn completes (isBusy goes from true to false), update timestamp
  const prevIsBusyRef = useRef(isBusy);
  useEffect(() => {
    if (prevIsBusyRef.current && !isBusy) {
      // Turn just completed
      updateLastApiCallTime();
    }
    prevIsBusyRef.current = isBusy;
  }, [isBusy, updateLastApiCallTime]);

  const isCacheExpired = useCallback(() => {
    if (lastApiCallTimeRef.current === null) {
      // Never made a call (or just app started), cache is cold
      return true;
    }
    return Date.now() - lastApiCallTimeRef.current > CACHE_TTL_MS;
  }, []);

  const triggerWarmupIfNeeded = useCallback(() => {
    // Skip if already warming
    if (isWarmingRef.current) {
      return;
    }

    // Skip if Super-MCP not ready (tools needed for cache hierarchy match)
    if (!superMcpReady) {
      return;
    }

    // Skip if agent is busy (turn in progress, don't interfere)
    if (isBusy) {
      return;
    }

    // Skip if cache is still warm
    if (!isCacheExpired()) {
      return;
    }

    // Start warmup
    isWarmingRef.current = true;
    abortControllerRef.current = new AbortController();

    // Fire and forget - don't await, don't block
    window.agentApi?.warmCache?.({})
      .then((result) => {
        if (result?.success) {
          // Warmup succeeded, update our local timestamp
          updateLastApiCallTime();
        }
      })
      .catch(() => {
        // Ignore errors - warmup is optional optimization
      })
      .finally(() => {
        isWarmingRef.current = false;
        abortControllerRef.current = null;
      });
  }, [superMcpReady, isBusy, isCacheExpired, updateLastApiCallTime]);

  const cancelWarmup = useCallback(() => {
    // Note: We can't actually cancel the IPC call, but we can signal
    // that we no longer care about the result. The main process warmup
    // runs fire-and-forget anyway, so this is mainly for cleanup.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isWarmingRef.current = false;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    triggerWarmupIfNeeded,
    cancelWarmup,
  };
}
