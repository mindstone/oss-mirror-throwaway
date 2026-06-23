import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@renderer/lib/utils';
import type { ImageContentBlock } from '@shared/types';
import { ImageContextMenu } from './ImageContextMenu';
import { useImageContextMenu } from './useImageContextMenu';
import styles from './ToolResultImage.module.css';

export type ToolResultImageProps = {
  image: ImageContentBlock;
  alt?: string;
  thumbnailSize?: 'default' | 'compact';
  showToast?: (options: { title: string }) => void;
};

const ToolResultImageComponent = ({
  image,
  alt = 'Tool result image',
  thumbnailSize = 'default',
  showToast,
}: ToolResultImageProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const { target: contextMenu, open: openContextMenu, close: closeContextMenu, handleMouseDown } = useImageContextMenu();
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const dataUrl = `data:${image.mimeType};base64,${image.data}`;

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    openContextMenu(event, { dataUrl });
  }, [openContextMenu, dataUrl]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setIsExpanded(true);
  }, []);

  const handleClose = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setIsExpanded(false);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsExpanded(false);
      }
    },
    []
  );

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlayRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isExpanded]);

  if (hasError) {
    return (
      <div className={cn(styles.image, styles.error)} role="img" aria-label="Failed to load image">
        <span className={styles.errorIcon} aria-hidden>
          ⚠️
        </span>
        <span className={styles.errorText}>Image failed to load</span>
      </div>
    );
  }

  const expandedOverlay = isExpanded ? (
    <div
      ref={overlayRef}
      className={styles.overlay}
      onClick={handleClose}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image view"
      tabIndex={0}
    >
      <div className={styles.overlayContent} onClick={(e) => e.stopPropagation()}>
        <img src={dataUrl} alt={alt} onContextMenu={handleContextMenu} />
        <button
          type="button"
          className={styles.closeButton}
          onClick={handleClose}
          aria-label="Close expanded view"
        >
          ✕
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={cn(
          styles.image,
          styles.thumbnail,
          thumbnailSize === 'compact' && styles.thumbnailCompact
        )}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        aria-label={`${alt} (click to expand)`}
      >
        <img src={dataUrl} alt={alt} onError={handleError} loading="lazy" />
      </button>

      {expandedOverlay ? createPortal(expandedOverlay, document.body) : null}

      <ImageContextMenu
        target={contextMenu}
        onClose={closeContextMenu}
        showToast={showToast}
      />
    </>
  );
};

export const ToolResultImage = memo(ToolResultImageComponent);
ToolResultImage.displayName = 'ToolResultImage';

export type ToolResultImagesProps = {
  images: ImageContentBlock[];
  showToast?: (options: { title: string }) => void;
};

const ToolResultImagesComponent = ({ images, showToast }: ToolResultImagesProps) => {
  if (!images || images.length === 0) {
    return null;
  }

  return (
    <div className={styles.images}>
      {images.map((image, index) => (
        <ToolResultImage
          key={`${image.mimeType}-${index}`}
          image={image}
          alt={`Tool result image ${index + 1}`}
          showToast={showToast}
        />
      ))}
    </div>
  );
};

export const ToolResultImages = memo(ToolResultImagesComponent);
ToolResultImages.displayName = 'ToolResultImages';
