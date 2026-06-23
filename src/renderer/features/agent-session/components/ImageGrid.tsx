import { memo, useCallback, useMemo, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { ImageTile } from './ImageTile';
import { ImageViewerDialog } from './ImageViewerDialog';
import type { ImageGridItem } from './imageGridSource';
import styles from './ImageGrid.module.css';

export interface ImageGridProps {
  images: ImageGridItem[];
  altLabel?: string;
  className?: string;
}

const PREVIEW_LIMIT = 11;
const DENSE_GRID_MIN = 4;
const DENSE_GRID_MAX = 12;

const ImageGridComponent = ({ images, altLabel, className }: ImageGridProps) => {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const openModal = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const closeModal = useCallback(() => {
    setActiveIndex(null);
  }, []);

  const handleIndexChange = useCallback((index: number) => {
    setActiveIndex(index);
  }, []);

  const total = images.length;

  const renderTile = useCallback(
    (item: ImageGridItem, index: number, variant: 'grid' | 'compact' | 'large' | 'row-large' = 'grid') => (
      <ImageTile
        key={item.key}
        src={item.tileSrc}
        alt={item.alt}
        state={item.state}
        variant={variant}
        ariaLabel={`${item.alt} (click to expand)`}
        title={item.mimeType ?? undefined}
        onClick={() => openModal(index)}
      />
    ),
    [openModal],
  );

  const layout = useMemo(() => {
    if (total === 0) {
      return null;
    }
    if (total <= 3) {
      const variant: 'grid' | 'large' | 'row-large' = total === 1 ? 'large' : 'row-large';
      return (
        <div
          className={cn(styles.row, total === 1 && styles.singleRow, total > 1 && styles.rowLarge)}
          role="list"
          aria-label={altLabel ?? `${total} image${total === 1 ? '' : 's'}`}
        >
          {images.map((item, index) => (
            <div role="listitem" key={item.key} className={styles.rowItem}>
              {renderTile(item, index, variant)}
            </div>
          ))}
        </div>
      );
    }
    if (total >= DENSE_GRID_MIN && total <= DENSE_GRID_MAX) {
      return (
        <div
          className={styles.grid}
          role="list"
          aria-label={altLabel ?? `${total} images`}
        >
          {images.map((item, index) => (
            <div role="listitem" key={item.key} className={styles.gridItem}>
              {renderTile(item, index)}
            </div>
          ))}
        </div>
      );
    }
    const preview = images.slice(0, PREVIEW_LIMIT);
    const remaining = total - preview.length;
    return (
      <div
        className={styles.grid}
        role="list"
        aria-label={altLabel ?? `${total} images, showing first ${preview.length}`}
      >
        {preview.map((item, index) => (
          <div role="listitem" key={item.key} className={styles.gridItem}>
            {renderTile(item, index)}
          </div>
        ))}
        <div role="listitem" className={styles.gridItem}>
          <button
            type="button"
            className={styles.moreTile}
            onClick={() => openModal(preview.length)}
            aria-label={`View all ${total} images`}
          >
            <span className={styles.moreLabel}>+{remaining}</span>
            <span className={styles.moreSubLabel}>more</span>
          </button>
        </div>
      </div>
    );
  }, [images, total, altLabel, renderTile, openModal]);

  if (total === 0) {
    return null;
  }

  return (
    <div className={cn(styles.container, className)} data-image-count={total}>
      {layout}
      <ImageViewerDialog
        images={images}
        activeIndex={activeIndex}
        onClose={closeModal}
        onIndexChange={handleIndexChange}
      />
    </div>
  );
};

export const ImageGrid = memo(ImageGridComponent);
ImageGrid.displayName = 'ImageGrid';
