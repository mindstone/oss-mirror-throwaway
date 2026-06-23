import { useEffect, useRef } from 'react';

export type UseInboxKeyboardShortcutsOptions = {
  containerRef: React.RefObject<HTMLElement | null>;
  focusedItemId: string | null;
  expandedItemId: string | null;
  selectedIds: Set<string>;
  isActive: boolean;

  onExecuteFocused: () => void;
  onDoneFocused: () => void;
  onDismissFocused: () => void;
  onScheduleCycleFocused?: () => void;
  onToggleSelectFocused: () => void;
  onSelectAll: () => void;
  onCollapseExpand: () => void;
  onClearSelection: () => void;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
};

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Attaches a single keydown handler to the container element for inbox shortcuts.
 *
 * Shortcuts only fire when `isActive` is true and focus is NOT in an editable element.
 * Single-key actions (Enter, D, X, A, Space) additionally require `focusedItemId` to be set.
 *
 * Key map:
 *   Enter  — execute CTA on focused item
 *   D      — mark focused item as done
 *   X      — delete focused item
 *   S      — cycle schedule on focused item (Today → This Week → Later → Today)
 *   Space  — toggle selection on focused item
 *   J / ↓  — move focus down
 *   K / ↑  — move focus up
 *   ⌘/Ctrl+A — select all
 *   Escape — collapse expanded / clear selection
 */
export function useInboxKeyboardShortcuts(options: UseInboxKeyboardShortcutsOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const containerRefStable = options.containerRef;

  useEffect(() => {
    const container = containerRefStable.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const opts = optionsRef.current;
      if (!opts.isActive) return;
      if (e.defaultPrevented) return;
      if (isEditableElement(document.activeElement)) return;

      // Cmd/Ctrl+A: select all
      if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        opts.onSelectAll();
        return;
      }

      // Skip remaining shortcuts when modifier keys are held (besides Escape)
      if (e.key !== 'Escape' && (e.metaKey || e.ctrlKey || e.altKey)) return;

      switch (e.key) {
        case 'Escape':
          if (opts.expandedItemId) {
            e.preventDefault();
            opts.onCollapseExpand();
          } else if (opts.selectedIds.size > 0) {
            e.preventDefault();
            opts.onClearSelection();
          }
          return;

        case 'ArrowUp':
        case 'k':
        case 'K':
          e.preventDefault();
          opts.onNavigateUp();
          return;

        case 'ArrowDown':
        case 'j':
        case 'J':
          e.preventDefault();
          opts.onNavigateDown();
          return;
      }

      // Single-key shortcuts require a focused item
      if (!opts.focusedItemId) return;

      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          opts.onExecuteFocused();
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          opts.onDoneFocused();
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          opts.onDismissFocused();
          break;
        case 's':
          e.preventDefault();
          opts.onScheduleCycleFocused?.();
          break;
        case ' ':
          e.preventDefault();
          opts.onToggleSelectFocused();
          break;
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRefStable]);
}
