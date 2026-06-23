import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Tooltip } from '@renderer/components/ui';
import styles from './ImageTile.module.css';
import type { ImageTileState } from './imageGridSource';

export type ImageTileVariant = 'grid' | 'compact' | 'large' | 'row-large';

const FAILED_TILE_LABEL = 'Image unavailable';

export interface ImageTileProps {
  src: string;
  alt: string;
  state?: ImageTileState;
  variant?: ImageTileVariant;
  ariaLabel?: string;
  title?: string;
  failedMessage?: string;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const ImageTileComponent = ({
  src,
  alt,
  state = 'ready',
  variant = 'grid',
  ariaLabel,
  title,
  failedMessage,
  onClick,
  onContextMenu,
}: ImageTileProps) => {
  const [internalState, setInternalState] = useState<ImageTileState>(state);
  const lastSrcRef = useRef<string>(src);
  const describedById = useId();

  useEffect(() => {
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      setInternalState(state);
    } else {
      setInternalState(state);
    }
  }, [src, state]);

  const handleError = useCallback(() => {
    setInternalState((prev) => (prev === 'failed' ? prev : 'failed'));
  }, []);

  const handleLoad = useCallback(() => {
    setInternalState((prev) => (prev === 'failed' ? prev : 'ready'));
  }, []);

  const isFailed = internalState === 'failed';
  const isLoading = internalState === 'loading';
  const failedCopy = failedMessage ?? FAILED_TILE_LABEL;
  const effectiveAriaLabel = isFailed ? failedCopy : (ariaLabel ?? alt);
  const effectiveTitle = isFailed ? failedCopy : title;

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2) {
      event.preventDefault();
    }
  }, []);

  const button = (
    <button
      type="button"
      className={cn(
        styles.tile,
        styles[`variant-${variant}`],
        isFailed && styles.tileFailed,
        isLoading && styles.tileLoading,
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseDown={handleMouseDown}
      aria-label={effectiveAriaLabel}
      aria-describedby={isFailed ? describedById : undefined}
      title={effectiveTitle}
      data-state={internalState}
    >
      {isFailed ? (
        <>
          <span className={styles.failedContent}>
            <ImageOff size={20} aria-hidden />
            <span className={styles.failedLabel}>{failedCopy}</span>
          </span>
          <span id={describedById} className={styles.srOnly}>
            {failedCopy}
          </span>
        </>
      ) : (
        <>
          {isLoading ? <span className={styles.skeleton} aria-hidden /> : null}
          <img
            src={src}
            alt={alt}
            onError={handleError}
            onLoad={handleLoad}
            loading="lazy"
            draggable={false}
          />
        </>
      )}
    </button>
  );

  if (isFailed) {
    return (
      <Tooltip content={failedCopy} placement="top">
        {button}
      </Tooltip>
    );
  }

  return button;
};

export const ImageTile = memo(ImageTileComponent);
ImageTile.displayName = 'ImageTile';
