import { useCallback, useEffect, useState } from 'react';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

/**
 * Hook to manage demo mode state.
 * Provides current state and exit handler.
 */
export function useDemoMode() {
  const [isActive, setIsActive] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  // Check initial status
  useEffect(() => {
    window.demoApi.status().then((status) => {
      setIsActive(status.active);
    });
  }, []);

  // Listen for changes
  useIpcEvent(window.api.onDemoModeChange, (data) => {
    setIsActive(data.active);
  }, []);

  const exitDemoMode = useCallback(async () => {
    setIsExiting(true);
    try {
      const result = await window.demoApi.exit();
      if (!result.success) {
        console.error('Failed to exit demo mode:', result.error);
        return false;
      }
      return true;
    } finally {
      setIsExiting(false);
    }
  }, []);

  return {
    isDemoMode: isActive,
    isExitingDemoMode: isExiting,
    exitDemoMode,
  };
}
