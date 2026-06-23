import { useEffect } from 'react';

type UseEscapeHatchHotkeyOptions = {
  isActive: boolean;
  onTrigger: () => void;
  preventDefault?: boolean;
  stopPropagation?: boolean;
};

/**
 * Shared hook to register the escape-hatch hotkey:
 * Cmd/Ctrl + Shift + Alt/Option + E
 *
 * Uses e.code ('KeyE') to avoid Mac Option+E dead-key issues.
 */
export const useEscapeHatchHotkey = ({
  isActive,
  onTrigger,
  preventDefault = true,
  stopPropagation = true
}: UseEscapeHatchHotkeyOptions): void => {
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = /mac|darwin/i.test(navigator.platform);
      const hasCommandOrControl = isMac ? e.metaKey : e.ctrlKey;
      if (hasCommandOrControl && e.shiftKey && e.altKey && e.code === 'KeyE') {
        if (preventDefault) e.preventDefault();
        if (stopPropagation) e.stopPropagation();
        try { onTrigger(); } catch { /* ignore */ }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, onTrigger, preventDefault, stopPropagation]);
};





