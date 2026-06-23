/**
 * useClipboard — Plugin hook for write-only clipboard access
 *
 * Uses `navigator.clipboard.writeText` directly in the renderer.
 * No IPC needed. Returns true on success, false on failure.
 * Does not show a toast — the plugin can handle its own UI feedback.
 *
 * Not debounced — clipboard writes are user-triggered.
 */

import { useCallback } from 'react';
import type { ClipboardApi } from './types';

export function useClipboard(): ClipboardApi {
  const copyText = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { copyText };
}
