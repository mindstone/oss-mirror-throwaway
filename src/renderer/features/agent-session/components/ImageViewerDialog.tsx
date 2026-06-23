import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dialog, IconButton } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import type { ImageGridItem } from './imageGridSource';
import styles from './ImageViewerDialog.module.css';

export interface ImageViewerDialogProps {
  images: ImageGridItem[];
  activeIndex: number | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

const VIRTUALIZE_AT = 12;
const THUMB_STRIP_HEIGHT = 88;
const THUMB_TILE_WIDTH = 96;
const THUMB_GAP = 8;

const ImageViewerDialogComponent = ({
  images,
  activeIndex,
  onClose,
  onIndexChange,
}: ImageViewerDialogProps) => {
  const open = activeIndex !== null;
  const total = images.length;
  const safeIndex = activeIndex === null ? 0 : Math.min(Math.max(activeIndex, 0), total - 1);
  const activeImage = images[safeIndex];

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose],
  );

  const handlePrev = useCallback(() => {
    if (total <= 1) return;
    const nextIndex = safeIndex - 1 < 0 ? total - 1 : safeIndex - 1;
    onIndexChange(nextIndex);
  }, [safeIndex, total, onIndexChange]);

  const handleNext = useCallback(() => {
    if (total <= 1) return;
    const nextIndex = safeIndex + 1 >= total ? 0 : safeIndex + 1;
    onIndexChange(nextIndex);
  }, [safeIndex, total, onIndexChange]);

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = closeButtonRef.current ?? viewerRef.current;
    focusTarget?.focus();
    return () => {
      const previous = previouslyFocusedElementRef.current;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
      previouslyFocusedElementRef.current = null;
    };
  }, [open]);

  const trapFocus = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const container = viewerRef.current;
    if (!container) return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handlePrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleNext();
      } else if (event.key === 'Tab') {
        trapFocus(event);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, handlePrev, handleNext, trapFocus]);

  const stripScrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: total,
    horizontal: true,
    getScrollElement: () => stripScrollRef.current,
    estimateSize: () => THUMB_TILE_WIDTH + THUMB_GAP,
    overscan: 6,
    getItemKey: (index) => images[index]?.key ?? `viewer-thumb-${index}`,
  });

  useEffect(() => {
    if (!open) return;
    if (total <= VIRTUALIZE_AT) return;
    virtualizer.scrollToIndex(safeIndex, { align: 'center' });
  }, [open, safeIndex, total, virtualizer]);

  const showStrip = total > VIRTUALIZE_AT;

  const virtualItems = showStrip ? virtualizer.getVirtualItems() : [];

  const titleId = useMemo(() => `image-viewer-title-${Math.random().toString(36).slice(2)}`, []);

  if (!open || !activeImage) {
    return (
      <Dialog open={false} onOpenChange={handleOpenChange}>
        <span />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} overlayClassName={styles.overlay} ariaLabelledBy={titleId}>
      <div
        ref={viewerRef}
        className={styles.viewer}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <header className={styles.viewerHeader}>
          <span id={titleId} className={styles.viewerTitle}>
            Image {safeIndex + 1} of {total}
          </span>
          <IconButton
            ref={closeButtonRef}
            size="sm"
            variant="ghost"
            aria-label="Close image viewer"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </IconButton>
        </header>
        <div className={styles.viewerBody}>
          {total > 1 ? (
            <IconButton
              size="md"
              variant="framed"
              aria-label="Previous image"
              onClick={handlePrev}
              className={styles.navButtonLeft}
            >
              <ChevronLeft size={20} aria-hidden />
            </IconButton>
          ) : null}
          <div className={styles.viewerStage}>
            <img
              key={activeImage.key}
              src={activeImage.fullSrc}
              alt={activeImage.alt}
              className={styles.viewerImage}
              draggable={false}
            />
          </div>
          {total > 1 ? (
            <IconButton
              size="md"
              variant="framed"
              aria-label="Next image"
              onClick={handleNext}
              className={styles.navButtonRight}
            >
              <ChevronRight size={20} aria-hidden />
            </IconButton>
          ) : null}
        </div>
        {showStrip ? (
          <div className={styles.thumbStripWrapper}>
            <div ref={stripScrollRef} className={styles.thumbStrip}>
              <div
                className={styles.thumbStripInner}
                style={{ width: virtualizer.getTotalSize() }}
              >
                {virtualItems.map((virtualCol) => {
                  const item = images[virtualCol.index];
                  if (!item) return null;
                  const isActive = virtualCol.index === safeIndex;
                  return (
                    <button
                      key={virtualCol.key}
                      type="button"
                      className={cn(styles.thumbStripItem, isActive && styles.thumbStripItemActive)}
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: THUMB_TILE_WIDTH,
                        height: THUMB_STRIP_HEIGHT - 8,
                        transform: `translateX(${virtualCol.start}px)`,
                      }}
                      onClick={() => onIndexChange(virtualCol.index)}
                      aria-label={`Show ${item.alt}`}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <img src={item.tileSrc} alt="" loading="lazy" draggable={false} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : total > 1 ? (
          <div className={styles.thumbStripWrapper}>
            <div className={styles.thumbStripStatic}>
              {images.map((item, idx) => {
                const isActive = idx === safeIndex;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={cn(styles.thumbStripItemStatic, isActive && styles.thumbStripItemActive)}
                    onClick={() => onIndexChange(idx)}
                    aria-label={`Show ${item.alt}`}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <img src={item.tileSrc} alt="" loading="lazy" draggable={false} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};

export const ImageViewerDialog = memo(ImageViewerDialogComponent);
ImageViewerDialog.displayName = 'ImageViewerDialog';
