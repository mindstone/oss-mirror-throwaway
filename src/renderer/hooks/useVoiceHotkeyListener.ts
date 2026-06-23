/**
 * useVoiceHotkeyListener - Voice activation hotkey IPC listener
 *
 * Subscribes to voice activation hotkey events from main process.
 * Uses a ref pattern to avoid re-subscribing on handler changes.
 */

import { useEffect, useRef } from 'react';

/** Payload from voice activation hotkey with optional screenshot */
export interface VoiceActivationHotkeyPayload {
  screenshot: {
    base64Data: string;
    width: number;
    height: number;
    sizeBytes: number;
  } | null;
  screenshotError?: 'screen-permission' | 'capture-failed';
}

/**
 * Subscribes to voice activation hotkey events.
 * The ref pattern ensures the IPC listener doesn't need to re-subscribe
 * when the handler callback changes.
 */
export function useVoiceHotkeyListener(handler: (payload?: VoiceActivationHotkeyPayload) => void): void {
  const handlerRef = useRef(handler);

  // Keep ref in sync with latest handler
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  // Subscribe to IPC event - use stable listener that calls current ref
  useEffect(() => {
    const listener = (payload?: VoiceActivationHotkeyPayload) => {
      handlerRef.current(payload);
    };
    const unsubscribe = window.api.onVoiceActivationHotkey(listener);
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, []);
}
