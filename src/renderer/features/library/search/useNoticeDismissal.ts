import { useCallback, useEffect, useMemo, useState } from 'react';

export type TruncationDismissReason = 'engine-cap' | 'tree' | 'both';

const DISMISS_PREFIX = 'library-search-truncation-notice-dismissed';

function getDismissKey(reason: TruncationDismissReason): string {
  return `${DISMISS_PREFIX}:${reason}`;
}

function safeReadSessionStorage(key: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function safeWriteSessionStorage(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(key, '1');
  } catch {
    // Ignore storage failures (private mode / disabled storage).
  }
}

export function useNoticeDismissal(reason: TruncationDismissReason): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const storageKey = useMemo(() => getDismissKey(reason), [reason]);
  const [dismissed, setDismissed] = useState<boolean>(() => safeReadSessionStorage(storageKey));

  useEffect(() => {
    setDismissed(safeReadSessionStorage(storageKey));
  }, [storageKey]);

  const dismiss = useCallback(() => {
    safeWriteSessionStorage(storageKey);
    setDismissed(true);
  }, [storageKey]);

  return { dismissed, dismiss };
}
