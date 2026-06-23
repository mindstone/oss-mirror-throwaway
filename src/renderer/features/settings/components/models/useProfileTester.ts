import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '@shared/types';

/**
 * Hook that manages model-profile chat-compatibility testing.
 *
 * Design notes (see `docs/plans/260424_model_profile_ui_redesign.md`):
 * - Per-profile request IDs (`Map<key, counter>`) so concurrent tests for
 *   different profiles never invalidate each other, and concurrent tests for
 *   the same profile follow last-writer-wins semantics.
 * - `runTest` always resolves with a structured result (never throws), so
 *   `Promise.allSettled` can aggregate outcomes cleanly.
 * - `runTests` uses `Promise.allSettled` with no concurrency cap — realistic
 *   profile counts are small; providers handle their own rate limits.
 * - Persistence of compatibility verdicts happens only for keys that match a
 *   persisted profile ID — wizard-draft keys (e.g. `wizard-draft:add`) never
 *   touch stored profiles.
 */

/** Parameters forwarded to the `settings:test-model-profile` IPC channel. */
export interface TestProfileParams {
  serverUrl: string;
  model?: string;
  apiKey?: string;
  providerType?: string;
  customProviderId?: string;
}

/** Structured return from a single test — `runTest` never rejects. */
export interface TestResult {
  success: boolean;
  latencyMs?: number;
  modelResponse?: string;
  error?: string;
  chatIncompatible?: boolean;
  jsonIncompatible?: boolean;
  thinkingIncompatible?: boolean;
  toolUseIncompatible?: boolean;
}

/** UI-facing state entry for a single profile key. */
export interface TestStateEntry {
  testing: boolean;
  result?: TestResult;
}

export interface UseProfileTesterReturn {
  /** Map from profile key (profile ID or wizard-draft key) to the latest state entry. */
  testState: Record<string, TestStateEntry>;
  /** Run a single test for `key` with `params`. Always resolves. */
  runTest: (key: string, params: TestProfileParams) => Promise<TestResult>;
  /** Run multiple tests in parallel via `Promise.allSettled`. Always resolves. */
  runTests: (keys: string[], paramsByKey: Record<string, TestProfileParams>) => Promise<TestResult[]>;
  /** True while a batch (`runTests`) is in flight. */
  isBatchRunning: boolean;
  /** True while a single-profile test is in flight for this key. */
  isTesting: (key: string) => boolean;
}

interface UseProfileTesterOptions {
  profiles: ModelProfile[];
  onProfilesChange: (profiles: ModelProfile[]) => void;
}

const TEST_RESULT_AUTO_CLEAR_MS = 8000;

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Test request failed.';
}

export function useProfileTester({
  profiles,
  onProfilesChange,
}: UseProfileTesterOptions): UseProfileTesterReturn {
  const [testState, setTestState] = useState<Record<string, TestStateEntry>>({});
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  // Per-key request counter. Incremented on each runTest call; only the call
  // whose ID is still the latest after awaiting may write state / persist.
  const requestIdsRef = useRef<Map<string, number>>(new Map());

  // Keep the latest profiles + callback available inside async callbacks
  // without forcing callers to memoize.
  const profilesRef = useRef(profiles);
  const onProfilesChangeRef = useRef(onProfilesChange);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    onProfilesChangeRef.current = onProfilesChange;
  }, [onProfilesChange]);

  // Track scheduled auto-clear timers so they can be cancelled on unmount.
  const clearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = clearTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const scheduleAutoClear = useCallback((key: string) => {
    const existing = clearTimersRef.current.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      clearTimersRef.current.delete(key);
      setTestState((prev) => {
        const entry = prev[key];
        if (!entry || entry.testing) return prev;
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
    }, TEST_RESULT_AUTO_CLEAR_MS);

    clearTimersRef.current.set(key, timer);
  }, []);

  const persistVerdict = useCallback(
    (key: string, result: TestResult) => {
      // Use the freshest snapshot we have. profilesRef is advanced eagerly
      // below after we call onProfilesChange, so back-to-back persistVerdict
      // calls in the same microtask batch see each other's merges rather than
      // clobbering them via React's async state update.
      const currentProfiles = profilesRef.current;
      const match = currentProfiles.find((p) => p.id === key);
      if (!match) return; // Profile deleted, or wizard-draft/unknown key — no persistence.

      const now = new Date().toISOString();
      let chatVerdict: 'compatible' | 'incompatible' | null = null;
      if (result.chatIncompatible) chatVerdict = 'incompatible';
      else if (result.success) chatVerdict = 'compatible';

      let jsonVerdict: 'compatible' | 'incompatible' | null = null;
      if (result.jsonIncompatible === true) jsonVerdict = 'incompatible';
      else if (result.jsonIncompatible === false) jsonVerdict = 'compatible';

      let thinkingVerdict: 'compatible' | 'incompatible' | null = null;
      if (result.thinkingIncompatible === true) thinkingVerdict = 'incompatible';
      else if (result.thinkingIncompatible === false) thinkingVerdict = 'compatible';

      let toolUseVerdict: 'compatible' | 'incompatible' | null = null;
      if (result.toolUseIncompatible === true) toolUseVerdict = 'incompatible';
      else if (result.toolUseIncompatible === false) toolUseVerdict = 'compatible';

      if (!chatVerdict && !jsonVerdict && !thinkingVerdict && !toolUseVerdict) return;

      const next = currentProfiles.map((p) =>
        p.id === key
          ? {
              ...p,
              ...(chatVerdict
                ? {
                    chatCompatibility: chatVerdict,
                    chatCompatibilityCheckedAt: now,
                  }
                : {}),
              ...(jsonVerdict
                ? {
                    jsonCompatibility: jsonVerdict,
                    jsonCompatibilityCheckedAt: now,
                  }
                : {}),
              ...(thinkingVerdict
                ? {
                    thinkingCompatibility: thinkingVerdict,
                    thinkingCompatibilityCheckedAt: now,
                  }
                : {}),
              ...(toolUseVerdict
                ? {
                    toolUseCompatibility: toolUseVerdict,
                    toolUseCompatibilityCheckedAt: now,
                  }
                : {}),
            }
          : p,
      );
      // Advance the ref eagerly so the next persistVerdict that fires before
      // React re-renders sees our merge rather than the pre-merge snapshot.
      // The effect below will still re-sync when the parent actually updates,
      // but until then we stay coherent with ourselves.
      profilesRef.current = next;
      onProfilesChangeRef.current(next);
    },
    [],
  );

  const runTest = useCallback(
    async (key: string, params: TestProfileParams): Promise<TestResult> => {
      const nextId = (requestIdsRef.current.get(key) ?? 0) + 1;
      requestIdsRef.current.set(key, nextId);

      // Cancel any scheduled auto-clear — a new run supersedes it.
      const pendingClear = clearTimersRef.current.get(key);
      if (pendingClear) {
        clearTimeout(pendingClear);
        clearTimersRef.current.delete(key);
      }

      setTestState((prev) => ({ ...prev, [key]: { testing: true } }));

      let result: TestResult;
      try {
        const response = await window.settingsApi.testModelProfile({
          serverUrl: params.serverUrl,
          model: params.model || undefined,
          apiKey: params.apiKey || undefined,
          providerType: params.providerType || undefined,
          customProviderId: params.customProviderId || undefined,
        });
        result = {
          success: response.success,
          latencyMs: response.latencyMs,
          modelResponse: response.modelResponse,
          error: response.error,
          chatIncompatible: response.chatIncompatible,
          jsonIncompatible: response.jsonIncompatible,
          thinkingIncompatible: response.thinkingIncompatible,
          toolUseIncompatible: response.toolUseIncompatible,
        };
      } catch (error) {
        result = { success: false, error: extractErrorMessage(error) };
      }

      // Stale? Another call for this key has superseded us.
      if (requestIdsRef.current.get(key) !== nextId) {
        return result;
      }

      setTestState((prev) => ({ ...prev, [key]: { testing: false, result } }));
      persistVerdict(key, result);
      scheduleAutoClear(key);

      return result;
    },
    [persistVerdict, scheduleAutoClear],
  );

  const runTests = useCallback(
    async (
      keys: string[],
      paramsByKey: Record<string, TestProfileParams>,
    ): Promise<TestResult[]> => {
      if (keys.length === 0) return [];
      setIsBatchRunning(true);
      try {
        const settled = await Promise.allSettled(
          keys.map((key) => {
            const params = paramsByKey[key];
            if (!params) {
              return Promise.resolve<TestResult>({
                success: false,
                error: 'Missing test parameters for profile.',
              });
            }
            return runTest(key, params);
          }),
        );
        return settled.map((entry) =>
          entry.status === 'fulfilled'
            ? entry.value
            : { success: false, error: extractErrorMessage(entry.reason) },
        );
      } finally {
        setIsBatchRunning(false);
      }
    },
    [runTest],
  );

  const isTesting = useCallback(
    (key: string) => Boolean(testState[key]?.testing),
    [testState],
  );

  return {
    testState,
    runTest,
    runTests,
    isBatchRunning,
    isTesting,
  };
}
