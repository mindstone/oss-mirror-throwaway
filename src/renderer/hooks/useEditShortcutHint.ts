import { useEffect, useState } from 'react';

/** Default delay before showing the edit shortcut hint (ms) */
const DEFAULT_EDIT_SHORTCUT_HINT_DELAY_MS = 1200;

/**
 * Options for the useEditShortcutHint hook.
 */
export interface UseEditShortcutHintOptions {
  /** Whether the inline edit button should be visible (has user messages or is editing) */
  showInlineEditButton: boolean;
  /** Whether the user is currently editing a message */
  isEditing: boolean;
  /** Whether text mode is active (vs voice mode) */
  isTextMode: boolean;
  /** Whether the composer has any text content */
  composerHasText: boolean;
  /** Delay in ms before showing the hint. Defaults to 1200ms */
  delayMs?: number;
}

/**
 * Hook for managing the edit shortcut hint timer.
 * Shows a hint (e.g., "Press ⌘↑ to edit") after a delay when:
 * - Composer is empty
 * - User is in text mode
 * - User is not currently editing
 * - There are messages that could be edited
 *
 * The hint is hidden immediately if any of these conditions change.
 *
 * @example
 * const showEditShortcutHint = useEditShortcutHint({
 *   showInlineEditButton: hasUserMessages || isEditing,
 *   isEditing,
 *   isTextMode,
 *   composerHasText,
 * });
 *
 * // Use showEditShortcutHint to conditionally render the hint UI
 */
export function useEditShortcutHint({
  showInlineEditButton,
  isEditing,
  isTextMode,
  composerHasText,
  delayMs = DEFAULT_EDIT_SHORTCUT_HINT_DELAY_MS,
}: UseEditShortcutHintOptions): boolean {
  const [showEditShortcutHint, setShowEditShortcutHint] = useState(false);

  useEffect(() => {
    // Hide hint immediately if conditions aren't met
    if (!showInlineEditButton || isEditing || !isTextMode || composerHasText) {
      setShowEditShortcutHint(false);
      return;
    }

    // SSR guard
    if (typeof window === 'undefined') {
      return;
    }

    // Show hint after delay
    const timeoutId = window.setTimeout(() => setShowEditShortcutHint(true), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [composerHasText, delayMs, isEditing, isTextMode, showInlineEditButton]);

  return showEditShortcutHint;
}
