import { useEffect } from 'react';

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
};

type Options = {
  enabled?: boolean;
};

/**
 * Subscribe to `library:changed` IPC events and invoke `onTreeChanged` when
 * the event indicates the file tree was affected. Safe to mount from multiple
 * places — each instance has its own subscription. Use this in any component
 * that owns a `useLibraryTree` instance and needs to stay in sync with
 * external file mutations.
 *
 * Stability: pass a stable `onTreeChanged` reference (e.g. via `useCallback`).
 * Identity changes resubscribe the IPC listener on every render of the caller.
 * If `window.api.onLibraryChanged` is unavailable (tests, SSR, narrow preload),
 * the hook is a graceful no-op.
 */
export function useLibraryTreeChangedReload(
  onTreeChanged: () => void,
  options?: Options,
): void {
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const api = (window as unknown as {
      api?: {
        onLibraryChanged?: (callback: (event: LibraryChangedEvent) => void) => () => void;
      };
    }).api;
    if (typeof api?.onLibraryChanged !== 'function') return;

    const unsubscribe = api.onLibraryChanged((event) => {
      if (event.affectsTree) {
        onTreeChanged();
      }
    });
    return () => unsubscribe();
  }, [enabled, onTreeChanged]);
}
