import type { MouseEvent as ReactMouseEvent } from 'react';

export function shouldIgnoreCardClick(event: ReactMouseEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return true;
  }

  if (event.button !== 0) {
    return true;
  }

  if (typeof window !== 'undefined') {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      return true;
    }
  }

  return false;
}
