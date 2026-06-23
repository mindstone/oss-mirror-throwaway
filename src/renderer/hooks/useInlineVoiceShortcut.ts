/**
 * useInlineVoiceShortcut - In-app shortcut to toggle voice recording
 *
 * Listens for a configurable keyboard shortcut and calls the provided toggle
 * callback. Unlike the global voice activation hotkey, this only works when
 * the app is focused and does NOT start a new conversation.
 */

import { useEffect, useRef } from 'react';
import { acceleratorFromEvent } from '@renderer/utils/acceleratorUtils';

interface UseInlineVoiceShortcutOptions {
  accelerator: string | null | undefined;
  onToggle: () => void;
}

export function useInlineVoiceShortcut({ accelerator, onToggle }: UseInlineVoiceShortcutOptions): void {
  const onToggleRef = useRef(onToggle);
  useEffect(() => { onToggleRef.current = onToggle; }, [onToggle]);

  useEffect(() => {
    const trimmed = accelerator?.trim();
    if (!trimmed) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const matched = acceleratorFromEvent(event);
      if (matched === trimmed) {
        event.preventDefault();
        event.stopPropagation();
        onToggleRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [accelerator]);
}
