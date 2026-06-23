/**
 * useAppKeyboardShortcuts - Global keyboard shortcuts for App.tsx
 *
 * Handles:
 * - ESC: Exit voice mode (single) OR stop active agent turn (double-ESC)
 * - Cmd/Ctrl+I: Navigate to Inbox
 */

import { useEffect, useRef } from 'react';
import type { FlowSurface } from '../features/flow-panels/FlowPanelsProvider';

const DOUBLE_ESC_THRESHOLD_MS = 500;

interface UseAppKeyboardShortcutsOptions {
  isTextMode: boolean;
  setIsTextMode: (isText: boolean) => void;
  setVoiceMode: (isVoice: boolean) => void;
  stopSpeech: () => void;
  cancelRecording: () => void;
  focusCommandInput: () => void;
  setActiveSurface: (surface: FlowSurface) => void;
  setShowConversation: (show: boolean) => void;
  isBusy: boolean;
  isStopping: boolean;
  stopActiveTurn: () => Promise<void>;
  documentPreviewOpen: boolean;
}

/**
 * Registers global keyboard shortcuts for the app.
 */
export function useAppKeyboardShortcuts({
  isTextMode,
  setIsTextMode,
  setVoiceMode,
  stopSpeech,
  cancelRecording,
  focusCommandInput,
  setActiveSurface,
  setShowConversation,
  isBusy,
  isStopping,
  stopActiveTurn,
  documentPreviewOpen,
}: UseAppKeyboardShortcutsOptions): void {
  // Track last ESC press time for double-ESC detection
  const lastEscPressRef = useRef<number>(0);

  // Reset double-ESC tracking when turn ends (prevents stale armed state)
  useEffect(() => {
    if (!isBusy) {
      lastEscPressRef.current = 0;
    }
  }, [isBusy]);

  // ESC key: single-ESC exits voice mode, double-ESC stops active agent turn
  // Note: Other ESC handlers (Document Preview drawer, dialogs) take priority via defaultPrevented
  useEffect(() => {
    const handleEscapeKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;

      // Let other handlers (dialogs, drawers, menus) handle ESC first
      if (event.defaultPrevented) return;

      // Priority 1: If in voice mode, exit to text mode (single ESC)
      if (!isTextMode) {
        event.preventDefault();
        setIsTextMode(true);
        setVoiceMode(false);
        stopSpeech();
        cancelRecording();
        focusCommandInput();
        lastEscPressRef.current = 0; // Reset double-ESC tracking
        return;
      }

      // Priority 2: Double-ESC to stop agent turn
      // Skip if document preview drawer is open (it has its own ESC handler)
      if (isBusy && !isStopping && !documentPreviewOpen) {
        const now = Date.now();
        const timeSinceLastEsc = now - lastEscPressRef.current;

        if (timeSinceLastEsc < DOUBLE_ESC_THRESHOLD_MS) {
          // Double-ESC detected: stop the turn
          event.preventDefault();
          void stopActiveTurn();
          lastEscPressRef.current = 0;
        } else {
          // First ESC: arm for potential double-ESC
          lastEscPressRef.current = now;
        }
      }
    };

    window.addEventListener('keydown', handleEscapeKey);
    return () => window.removeEventListener('keydown', handleEscapeKey);
  }, [isTextMode, setIsTextMode, setVoiceMode, stopSpeech, cancelRecording, focusCommandInput, isBusy, isStopping, stopActiveTurn, documentPreviewOpen]);

  // Cmd+I to navigate to Inbox
  useEffect(() => {
    const handleInboxHotkey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        setActiveSurface('tasks');
        setShowConversation(true);
      }
    };

    window.addEventListener('keydown', handleInboxHotkey);
    return () => window.removeEventListener('keydown', handleInboxHotkey);
  }, [setActiveSurface, setShowConversation]);
}
