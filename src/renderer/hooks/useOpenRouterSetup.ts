import { useState, useCallback, useRef, useEffect } from 'react';
import { useTimeoutRef } from './useTimeoutRef';

export type SetupPhase = 'idle' | 'connecting' | 'waiting' | 'success' | 'error';

export const TIMEOUT_HINT_MS = 45_000;

const WAITING_MESSAGE =
  'Still waiting? Sometimes OpenRouter forgets to let us know. Try connecting again.';

export interface OpenRouterSetupState {
  phase: SetupPhase;
  error: string | null;
  maskedToken: string | null;
  buttonLabel: string;
  isLoading: boolean;
  handleConnect: () => void;
  handleDisconnect: () => Promise<void>;
  handleCancel: () => void;
  handleRetry: () => void;
  waitingMessage: string | null;
}

export function useOpenRouterSetup(hasToken: boolean): OpenRouterSetupState {
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [maskedToken, setMaskedToken] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const timeout = useTimeoutRef();

  // Sync phase with external token state (e.g. settings broadcast).
  // Only respond to hasToken prop changes — NOT internal phase transitions.
  useEffect(() => {
    if (hasToken) {
      // Invalidate any in-flight setup so stale responses don't overwrite success.
      ++requestIdRef.current;
      setPhase('success');
      setError(null);
      timeout.clear();
    } else {
      setPhase(prev => (prev === 'success' ? 'idle' : prev));
      setMaskedToken(null);
    }
  }, [hasToken, timeout]);

  // Invalidate any in-flight setup on unmount.
  //
  // The exhaustive-deps rule warns that `requestIdRef.current` may have
  // changed by cleanup time. That is precisely the semantics we want here:
  // we increment the LATEST counter value at unmount so any in-flight
  // setupToken() promise resolves into a stale-id branch and is ignored.
  // The "capture ref into local" workaround does not apply because we
  // are WRITING (++), not reading, the counter.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting requestIdRef and timeout from any captured-deps semantics; we WRITE (++) the ref counter at unmount so in-flight setupToken() promises resolve into the stale-id branch — capture-into-local does not apply to writes (see 8-line comment block above)
      ++requestIdRef.current;
      timeout.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting requestIdRef and timeout from deps; cleanup-only effect must run once on unmount, never on dep churn — adding either would cause the cleanup to fire on every change and invalidate live setupToken() promises
  }, []);

  const startConnect = useCallback(async (capturedId: number) => {
    try {
      const result = await window.openRouterApi.setupToken();

      if (capturedId !== requestIdRef.current) return;

      timeout.clear();

      switch (result.outcome) {
        case 'success':
          setMaskedToken(result.maskedKey);
          setPhase('success');
          setError(null);
          break;

        case 'cancelled':
          setPhase('idle');
          setError(null);
          break;

        case 'error':
          setPhase('error');
          setError(result.error);
          break;
      }
    } catch {
      if (capturedId !== requestIdRef.current) return;
      timeout.clear();
      setPhase('error');
      setError("Couldn't connect. Try again.");
    }
  }, [timeout]);

  const handleConnect = useCallback(() => {
    if (phase === 'connecting' || phase === 'waiting') return;
    const capturedId = ++requestIdRef.current;
    setPhase('connecting');
    setError(null);

    timeout.set(() => {
      if (capturedId !== requestIdRef.current) return;
      setPhase('waiting');
    }, TIMEOUT_HINT_MS);

    void startConnect(capturedId);
  }, [phase, timeout, startConnect]);

  const handleRetry = useCallback(() => {
    // Increment first to invalidate stale in-flight response, then cancel old attempt.
    // Electron IPC preserves message order within a renderer, so cancel-setup always
    // arrives before the subsequent setup-token on the main process.
    const capturedId = ++requestIdRef.current;
    timeout.clear();
    void Promise.resolve(window.openRouterApi.cancelSetup()).catch(() => {});
    setPhase('connecting');
    setError(null);

    timeout.set(() => {
      if (capturedId !== requestIdRef.current) return;
      setPhase('waiting');
    }, TIMEOUT_HINT_MS);

    void startConnect(capturedId);
  }, [timeout, startConnect]);

  const handleDisconnect = useCallback(async () => {
    try {
      await window.openRouterApi.disconnect();
    } catch {
      // Revocation may fail (network error, token already revoked) — still clear local state
    }
    setPhase('idle');
    setMaskedToken(null);
    setError(null);
  }, []);

  const handleCancel = useCallback(() => {
    ++requestIdRef.current;
    timeout.clear();
    void Promise.resolve(window.openRouterApi.cancelSetup()).catch(() => {});
    setPhase('idle');
    setError(null);
  }, [timeout]);

  const isLoading = phase === 'connecting' || phase === 'waiting';

  const buttonLabel = (() => {
    switch (phase) {
      case 'idle': return 'Connect';
      case 'connecting': return 'Connecting\u2026';
      case 'waiting': return 'Connecting\u2026';
      case 'success': return maskedToken ? `Connected (${maskedToken})` : 'Connected';
      case 'error': return 'Try again';
    }
  })();

  const waitingMessage = phase === 'waiting' ? WAITING_MESSAGE : null;

  return {
    phase,
    error,
    maskedToken,
    buttonLabel,
    isLoading,
    handleConnect,
    handleDisconnect,
    handleCancel,
    handleRetry,
    waitingMessage,
  };
}
