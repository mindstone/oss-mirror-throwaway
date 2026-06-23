import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ImageContextMenuTarget } from './ImageContextMenu';

/** Describes the image a context menu should act on (a data URL and/or a file path). */
export type ImageContextMenuSource = {
  dataUrl?: string;
  filePath?: string;
  fileName?: string;
};

export type UseImageContextMenuResult = {
  /** Current menu target, or null when closed. Pass to <ImageContextMenu target={...}>. */
  target: ImageContextMenuTarget | null;
  /** Open the menu at the event's cursor position for the given image source. */
  open: (event: MouseEvent, source: ImageContextMenuSource) => void;
  /** Close the menu. Pass to <ImageContextMenu onClose={...}>. */
  close: () => void;
  /** mousedown handler that suppresses focus on right-click (see note below). */
  handleMouseDown: (event: MouseEvent) => void;
};

/**
 * Shared right-click "Copy Image / Save Image As…" wiring for image surfaces.
 *
 * Electron's renderer has no built-in image context menu, and the global native
 * handler in `src/main/index.ts` only covers editable fields and text selections
 * — it short-circuits on images, leaving them silent. So every surface that wants
 * a working image right-click menu must supply its own React handler feeding
 * `<ImageContextMenu>`. This hook centralises that boilerplate (menu state, the
 * cursor-position payload, and the right-click focus guard) so each consumer only
 * has to render `<ImageContextMenu target={target} onClose={close} ... />`.
 */
export function useImageContextMenu(): UseImageContextMenuResult {
  const [target, setTarget] = useState<ImageContextMenuTarget | null>(null);

  const open = useCallback((event: MouseEvent, source: ImageContextMenuSource) => {
    event.preventDefault();
    event.stopPropagation();
    setTarget({ x: event.clientX, y: event.clientY, ...source });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  // Right-clicking a <button> focuses it and scroll-into-views, which jolts
  // virtualized lists that position rows via transforms. Suppressing focus on
  // the right mouse button avoids that jump.
  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (event.button === 2) event.preventDefault();
  }, []);

  return { target, open, close, handleMouseDown };
}
