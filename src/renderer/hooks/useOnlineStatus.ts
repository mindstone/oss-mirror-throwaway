import { useState, useEffect } from 'react';

/**
 * Hook to track browser online/offline status.
 *
 * Note: navigator.onLine can have false positives (reports online when actually
 * offline behind a captive portal, etc.). Use this for informational UI only,
 * not for critical logic.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
