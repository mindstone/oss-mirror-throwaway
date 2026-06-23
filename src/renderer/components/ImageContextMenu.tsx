import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download } from 'lucide-react';
import styles from './ImageContextMenu.module.css';

export type ImageContextMenuTarget = {
  x: number;
  y: number;
  dataUrl?: string;
  filePath?: string;
  fileName?: string;
};

export type ImageContextMenuProps = {
  target: ImageContextMenuTarget | null;
  onClose: () => void;
  showToast?: (options: { title: string }) => void;
};

const ImageContextMenuComponent = ({ target, onClose, showToast }: ImageContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (target) {
      setMenuPos({ x: target.x, y: target.y });
    } else {
      setMenuPos(null);
    }
  }, [target]);

  useLayoutEffect(() => {
    if (!target || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const padding = 8;
    let x = target.x;
    let y = target.y;
    if (x + rect.width + padding > viewportW) {
      x = Math.max(padding, viewportW - rect.width - padding);
    }
    if (y + rect.height + padding > viewportH) {
      y = Math.max(padding, viewportH - rect.height - padding);
    }
    if (!menuPos || x !== menuPos.x || y !== menuPos.y) {
      setMenuPos({ x, y });
    }
  }, [target, menuPos]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick, true);
    };
  }, [target, onClose]);

  const handleCopyImage = useCallback(async () => {
    if (!target) return;
    try {
      await window.appApi.copyImageToClipboard({
        dataUrl: target.dataUrl,
        filePath: target.filePath,
      });
      showToast?.({ title: 'Image copied to clipboard' });
    } catch (error) {
      console.error('Failed to copy image:', error);
      showToast?.({ title: "Couldn't copy that image" });
    }
    onClose();
  }, [target, onClose, showToast]);

  const handleSaveImage = useCallback(async () => {
    if (!target) return;
    try {
      const result = await window.appApi.saveImageAs({
        dataUrl: target.dataUrl,
        filePath: target.filePath,
        defaultName: target.fileName,
      });
      if (result.saved) {
        showToast?.({ title: 'Image saved' });
      }
    } catch (error) {
      console.error('Failed to save image:', error);
      showToast?.({ title: "Couldn't save that image" });
    }
    onClose();
  }, [target, onClose, showToast]);

  if (!target) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={styles.contextMenu}
      style={{ top: menuPos?.y ?? target.y, left: menuPos?.x ?? target.x }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
      data-testid="image-context-menu"
    >
      <button type="button" className={styles.contextMenuItem} onClick={() => void handleCopyImage()}>
        <Copy size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Copy Image</span>
      </button>
      <button type="button" className={styles.contextMenuItem} onClick={() => void handleSaveImage()}>
        <Download size={14} className={styles.contextMenuIcon} />
        <span className={styles.contextMenuLabel}>Save Image As...</span>
      </button>
    </div>,
    document.body
  );
};

export const ImageContextMenu = memo(ImageContextMenuComponent);
ImageContextMenu.displayName = 'ImageContextMenu';
