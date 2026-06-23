import { useState, useEffect, useCallback } from 'react';
import type { AuthState, AuthUser, AuthProvider } from '@shared/ipc/schemas/auth';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

export interface UseAuthReturn {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
  isGuestMode: boolean;
  login: (provider: AuthProvider) => Promise<void>;
  logout: () => Promise<void>;
  skipAuth: () => void;
  exitGuestMode: () => void;
}

/**
 * React hook for authentication state and actions.
 * Connects to the main process auth service via IPC.
 */
export function useAuth(): UseAuthReturn {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    isLoading: true,
  });
  const [isGuestMode, setIsGuestMode] = useState(
    () => sessionStorage.getItem('guestMode') === 'true'
  );

  // Sync guest mode state across hook instances via custom event.
  // We call handleGuestModeChange() on mount to catch any changes that occurred
  // between the initial useState read and this effect running (race condition
  // that E2E tests can hit when they set sessionStorage before React mounts).
  useEffect(() => {
    const handleGuestModeChange = () => {
      setIsGuestMode(sessionStorage.getItem('guestMode') === 'true');
    };
    // Sync immediately on mount to catch any changes made before listener attached
    handleGuestModeChange();
    window.addEventListener('guestModeChange', handleGuestModeChange);
    return () => window.removeEventListener('guestModeChange', handleGuestModeChange);
  }, []);

  // Fetch initial auth state
  useEffect(() => {
    let mounted = true;

    const fetchAuthState = async () => {
      try {
        const state = await window.authApi.getState();
        if (mounted) {
          setAuthState(state);
        }
      } catch {
        if (mounted) {
          setAuthState({
            isAuthenticated: false,
            user: null,
            isLoading: false,
          });
        }
      }
    };

    void fetchAuthState();

    return () => {
      mounted = false;
    };
  }, []);

  // Listen for auth state changes from main process
  useIpcEvent(window.api.onAuthStateChange, (state) => {
    setAuthState(state);
  }, []);

  const login = useCallback(async (provider: AuthProvider) => {
    await window.authApi.login({ provider });
  }, []);

  const logout = useCallback(async () => {
    localStorage.removeItem('rebel-login-email');
    await window.authApi.logout();
  }, []);

  const skipAuth = useCallback(() => {
    sessionStorage.setItem('guestMode', 'true');
    setIsGuestMode(true);
    window.dispatchEvent(new Event('guestModeChange'));
  }, []);

  const exitGuestMode = useCallback(() => {
    sessionStorage.removeItem('guestMode');
    setIsGuestMode(false);
    window.dispatchEvent(new Event('guestModeChange'));
  }, []);

  return {
    isAuthenticated: authState.isAuthenticated,
    user: authState.user,
    isLoading: authState.isLoading,
    isGuestMode,
    login,
    logout,
    skipAuth,
    exitGuestMode,
  };
}
